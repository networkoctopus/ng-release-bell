'use strict';

const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { spawnSync } = require('node:child_process');
const vm = require('node:vm');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'releasebell-filtering-'));
process.env.DB_PATH = path.join(dir, 'test.db');
process.env.DATA_DIR = dir;
// The transport is always mocked before any dispatch. Never use real SMTP.
process.env.MAIL_SMTP_SERVER = 'smtp.example.invalid';
process.env.MAIL_SMTP_PORT = '25';
process.env.MAIL_FROM = 'test@example.invalid';
fs.writeFileSync(path.join(dir, 'session.secret'), 'isolated-test-secret');
const database = require('../database.js');
const tasks = require('../tasks.js');
const routes = require('../routes.js');
const github = require('../github.js');
const nodemailer = require('nodemailer');
database.init();
after(() => fs.rmSync(dir, { recursive: true, force: true }));
let sequence = 0;
function user() {
    return database.users.add({ id: `user-${++sequence}`, email: 'test@example.invalid', githubToken: 'mock' });
}
function project(owner, options = {}) {
    return database.projects.add({ userId: owner.id, type: 'github_manual', name: `owner/repo-${++sequence}`, ...options });
}
async function request(handler, owner, body, projectId) {
    let response;
    await handler({ user: database.users.get(owner.id), body, params: { projectId } }, {}, value => { response = value; });
    return response;
}
function release(p, version, prerelease, extra = {}) {
    return database.releases.add({ projectId: p.id, version, prerelease, body: '', notified: false, createdAt: Date.now(), ...extra });
}
function mockGithub(t, listing, metadata = {}) {
    t.mock.method(github, 'getReleases', async (token, p) => listing.map(r => ({ ...r, projectId: p.id })));
    t.mock.method(github, 'getCommit', async () => ({ createdAt: new Date().toISOString(), message: 'fixture' }));
    t.mock.method(github, 'getRelease', async (token, p, version) => metadata[version] || { body: '', prerelease: false, publishedAt: new Date().toISOString() });
}

test('new manual and starred projects inherit; overrides survive changes in both directions', async t => {
    const owner = user();
    let response = await request(routes.profile.update, owner, { defaultExcludePrereleases: true });
    assert.equal(response.status, 202);
    const inherited = project(owner);
    const all = project(owner, { excludePrereleases: false });
    const stable = project(owner, { excludePrereleases: true });
    assert.equal(inherited.inheritReleaseFiltering, true);
    assert.equal(inherited.effectiveExcludePrereleases, true);
    assert.equal(all.effectiveExcludePrereleases, false);
    t.mock.method(github, 'getStarred', async () => [{ full_name: 'owner/starred' }]);
    mockGithub(t, []);
    await tasks.syncGithubStarredByUser({ ...database.users.get(owner.id), githubAutoImport: true });
    const imported = database.projects.listByType(owner.id, 'github')[0];
    assert.equal(imported.inheritReleaseFiltering, true);
    assert.equal(imported.effectiveExcludePrereleases, true);
    await request(routes.profile.update, owner, { defaultExcludePrereleases: false });
    assert.equal(database.projects.get(inherited.id).effectiveExcludePrereleases, false);
    assert.equal(database.projects.get(imported.id).effectiveExcludePrereleases, false);
    assert.equal(database.projects.get(stable.id).effectiveExcludePrereleases, true);
    assert.equal(database.projects.get(all.id).effectiveExcludePrereleases, false);
    response = await request(routes.projects.add, owner, { type: 'github_manual', name: 'owner/api-created' });
    assert.equal(response.status, 201);
    assert.equal(response.body.project.inheritReleaseFiltering, true);
});

test('stable-only detects stable behind a newer prerelease, including latest-version mode', async t => {
    const owner = user();
    await request(routes.profile.update, owner, { defaultExcludePrereleases: true });
    const p = project(owner, { latestVersionOnly: true });
    database.projects.update(p.id, { lastSuccessfulSyncAt: Date.now() });
    mockGithub(t, [{ projectId: p.id, version: 'v3.0.0-beta', sha: 'new' }, { projectId: p.id, version: 'v2.0.0', sha: 'stable' }], {
        'v3.0.0-beta': { body: '', prerelease: true, publishedAt: new Date().toISOString() }
    });
    await tasks.syncReleasesByProject(database.users.get(owner.id), database.projects.get(p.id));
    const pending = database.releases.listPendingForProject(p.id);
    assert.deepEqual(pending.map(r => r.version), ['v2.0.0']);
    assert.equal(database.projects.list(owner.id)[0].version, 'v2.0.0');
});

test('global all includes prereleases; explicit stable override and regex remain independent', async t => {
    const owner = user();
    const inherited = project(owner);
    const stable = project(owner, { excludePrereleases: true });
    const regex = project(owner, { versionFilters: JSON.stringify([{ value: 'beta', inverse: false }]) });
    mockGithub(t, [{ version: 'v2.0.0-beta', sha: 'tag' }], { 'v2.0.0-beta': { body: '', prerelease: true } });
    for (const p of [inherited, stable, regex]) {
        database.projects.update(p.id, { lastSuccessfulSyncAt: Date.now() });
        await tasks.syncReleasesByProject(owner, database.projects.get(p.id));
    }
    assert.equal(database.releases.listPendingForProject(inherited.id).length, 1);
    assert.equal(database.releases.listPendingForProject(stable.id).length, 0);
    assert.equal(database.releases.listPendingForProject(regex.id).length, 0);
});

test('promotion of an existing prerelease is notified once, even with excludeUpdated enabled', async t => {
    const owner = user();
    const p = project(owner, { excludePrereleases: true, excludeUpdated: true });
    database.projects.update(p.id, { lastSuccessfulSyncAt: Date.now() });
    const previous = release(p, 'v2.0.0', true, { notified: true, sha: 'unchanged' });
    mockGithub(t, [{ version: previous.version, sha: previous.sha }]);
    await tasks.syncReleasesByProject(owner, database.projects.get(p.id));
    assert.equal(database.releases.list(p.id)[0].prerelease, 0);
    assert.equal(database.releases.listPendingForProject(p.id).length, 1);
    const mails = [];
    t.mock.method(nodemailer, 'createTransport', () => ({ sendMail: async mail => { mails.push(mail); } }));
    // Isolate this dispatch from pending fixtures created by earlier tests.
    for (const r of database.releases.listAllPending()) if (r.projectId !== p.id) database.releases.update(r.id, { notified: true });
    await tasks.sendNotifications();
    await tasks.syncReleasesByProject(owner, database.projects.get(p.id));
    await tasks.sendNotifications();
    assert.equal(mails.length, 1);
    assert.match(mails[0].subject, /v2\.0\.0 released/);
    assert.equal(database.releases.list(p.id).length, 1);
});

test('failed metadata refresh never promotes a prerelease', async t => {
    const owner = user();
    const p = project(owner);
    release(p, 'v2.0.0', true, { notified: true });
    mockGithub(t, [{ version: 'v2.0.0' }]);
    t.mock.method(github, 'getRelease', async () => { throw new Error('fixture outage'); });
    await tasks.syncReleasesByProject(owner, p);
    assert.equal(database.releases.list(p.id)[0].prerelease, 1);
    assert.equal(database.releases.listPendingForProject(p.id).length, 0);
});

test('queued notifications respect current filtering, and widening never requeues history', async t => {
    const owner = user();
    const p = project(owner);
    release(p, 'v3.0.0-beta', true);
    release(p, 'v1.0.0', false, { notified: true });
    await request(routes.profile.update, owner, { defaultExcludePrereleases: true });
    const mails = [];
    t.mock.method(nodemailer, 'createTransport', () => ({ sendMail: async mail => { mails.push(mail); } }));
    await tasks.sendNotifications();
    assert.equal(database.releases.listPendingForProject(p.id).length, 0);
    await request(routes.profile.update, owner, { defaultExcludePrereleases: false });
    await tasks.sendNotifications();
    assert.equal(mails.length, 0);
    assert.equal(database.releases.list(p.id).length, 2);
});

test('daily, weekly and hourly scheduling is retained with filtering', async t => {
    const owner = user();
    const mails = [];
    t.mock.method(nodemailer, 'createTransport', () => ({ sendMail: async mail => { mails.push(mail); } }));
    for (const frequency of ['daily', 'weekly', 'hourly']) {
        const p = project(owner, { emailFrequency: frequency, excludePrereleases: true });
        const recent = new Date(); recent.setMinutes(0, 0, 0);
        t.mock.method(Date, 'now', () => recent.getTime());
        release(p, 'v1.0.0', false);
        release(p, 'v2.0.0-beta', true);
        database.projects.update(p.id, { lastNotifiedAt: Date.now() });
        const before = mails.length;
        await tasks.sendNotifications();
        assert.equal(mails.length, before + (frequency === 'hourly' ? 1 : 0));
        database.projects.update(p.id, { lastNotifiedAt: 0 });
        await tasks.sendNotifications();
        assert.equal(mails.length, before + 1);
        assert.equal(database.releases.listPendingForProject(p.id).length, 0);
        assert.doesNotMatch(mails.at(-1).text, /beta/);
        Date.now.mock.restore();
    }
});

test('initial imports suppress historical notifications and providers without detection retain behaviour', async t => {
    const owner = user();
    await request(routes.profile.update, owner, { defaultExcludePrereleases: true });
    const p = project(owner, { type: 'npm' });
    const npm = require('../npm.js');
    t.mock.method(npm, 'getReleases', async () => [{ projectId: p.id, version: '1.0.0-beta', prerelease: false, createdAt: Date.now() }]);
    await tasks.syncReleasesByProject(owner, p);
    assert.equal(database.releases.listPendingForProject(p.id).length, 0);
    t.mock.method(npm, 'getReleases', async () => [{ projectId: p.id, version: '2.0.0-beta', prerelease: false, createdAt: Date.now() }]);
    await tasks.syncReleasesByProject(owner, database.projects.get(p.id));
    assert.equal(database.releases.listPendingForProject(p.id).length, 1);
    database.releases.listPendingForProject(p.id).forEach(r => database.releases.update(r.id, { notified: true }));
});

test('v2 export/import preserves global settings, inheritance, overrides and disabled projects; v1 stays explicit', async t => {
    mockGithub(t, []);
    const owner = user();
    await request(routes.profile.update, owner, { defaultExcludePrereleases: true });
    project(owner);
    project(owner, { excludePrereleases: false, enabled: false });
    const exported = await request(routes.data.export, owner, {});
    assert.equal(exported.body.version, 2);
    const target = user();
    const result = await request(routes.data.import, target, exported.body);
    assert.equal(result.body.imported, 2);
    assert.equal(database.users.get(target.id).defaultExcludePrereleases, 1);
    const restored = database.projects.list(target.id);
    assert.equal(restored.filter(p => p.inheritReleaseFiltering).length, 1);
    assert.equal(restored.filter(p => !p.enabled).length, 1);
    const duplicate = await request(routes.data.import, target, exported.body);
    assert.equal(duplicate.body.skipped, 2);
    await request(routes.data.import, target, { version: 1, projects: [{ name: 'old/no-filter', type: 'github_manual' }, { name: 'old/stable', type: 'github_manual', excludePrereleases: true }] });
    assert.equal(database.projects.list(target.id).find(p => p.name === 'old/no-filter').effectiveExcludePrereleases, false);
    assert.equal(database.projects.list(target.id).find(p => p.name === 'old/stable').effectiveExcludePrereleases, true);
    const invalid = await request(routes.profile.update, owner, { defaultExcludePrereleases: 'false' });
    assert.equal(invalid.status, 400);
    const before = database.projects.list(owner.id);
    await request(routes.profile.update, owner, { makeProjectsInherit: true });
    assert.equal(database.projects.list(owner.id).every(p => p.inheritReleaseFiltering), true);
    assert.deepEqual(database.projects.list(owner.id).map(p => p.enabled), before.map(p => p.enabled));
});

test('existing SQLite upgrade keeps explicit preferences; migration reruns and process restart preserve inheritance', () => {
    const oldPath = path.join(dir, 'upgrade.db');
    const old = new DatabaseSync(oldPath);
    const schema = fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf8')
        .replace(/,\n {4}defaultExcludePrereleases INTEGER NOT NULL DEFAULT 0/, '')
        .replace(/ {4}inheritReleaseFiltering INTEGER NOT NULL DEFAULT 0,\n/, '');
    old.exec(schema);
    old.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run('old', 'old@example.invalid');
    old.prepare('INSERT INTO projects (id, userId, name, excludePrereleases) VALUES (?, ?, ?, ?)').run('old-all', 'old', 'owner/all', 0);
    old.prepare('INSERT INTO projects (id, userId, name, excludePrereleases) VALUES (?, ?, ?, ?)').run('old-stable', 'old', 'owner/stable', 1);
    require('../migrator.js').runMigrations(old);
    require('../migrator.js').runMigrations(old);
    assert.deepEqual(old.prepare('SELECT excludePrereleases, inheritReleaseFiltering FROM projects ORDER BY id').all().map(r => [r.excludePrereleases, r.inheritReleaseFiltering]), [[0, 0], [1, 0]]);
    old.exec('UPDATE users SET defaultExcludePrereleases=1; UPDATE projects SET inheritReleaseFiltering=1 WHERE id=\'old-all\'');
    old.close();
    const restarted = spawnSync(process.execPath, ['-e', 'const db=require(\'./backend/database.js\'); db.init(); console.log(JSON.stringify(db.projects.list(\'old\').map(p=>[p.inheritReleaseFiltering,p.effectiveExcludePrereleases])))'], { cwd: path.join(__dirname, '../..'), env: { ...process.env, DB_PATH: oldPath }, encoding: 'utf8' });
    assert.equal(restarted.status, 0, restarted.stderr);
    assert.match(restarted.stdout, /\[\[true,true\],\[false,true\]\]/);
});

test('Vue editor and preview resolve inherited and explicit filtering', async () => {
    const source = fs.readFileSync(path.join(__dirname, '../../frontend/App.vue'), 'utf8').split('<script>')[1].split('</script>')[0]
        .replace(/^import .*;\s*$/gm, '').replace('export default', 'module.exports =').replace(/import\.meta\.env\.VITE_API_ORIGIN/g, '\'\'');
    const context = { module: { exports: {} }, superagent: { get: async () => ({ body: { releases: [] } }) }, Button: {}, Dropdown: {}, DataTable: {}, Column: {}, InputSwitch: {}, ConfirmPopup: {}, MainLayout: {}, TopBar: {}, BottomBar: {}, console };
    vm.runInNewContext(source, context);
    const app = context.module.exports;
    const editor = { user: { defaultExcludePrereleases: 1 }, availableProjectTypes: [{ type: 'github_manual' }], editProjectDialog: {} };
    await app.methods.onShowEditProjectDialog.call(editor, { id: 'fixture', type: 'github_manual', name: 'owner/repo', inheritReleaseFiltering: true });
    assert.equal(editor.editProjectDialog.releaseFiltering, 'inherit');
    editor.editProjectDialog.releases = [{ version: 'v2.0.0-beta', prerelease: true }, { version: 'v1.0.0', prerelease: false }];
    assert.equal(app.computed.filteredReleasesPreview.call(editor)[0]._excluded, true);
    editor.editProjectDialog.releaseFiltering = 'all';
    assert.equal(app.computed.filteredReleasesPreview.call(editor)[0]._excluded, false);
});

test('all other release providers retain their existing no-prerelease-detection behaviour', async t => {
    const owner = user();
    await request(routes.profile.update, owner, { defaultExcludePrereleases: true });
    for (const type of ['gitlab', 'gitea', 'npm', 'pypi', 'dockerhub', 'quay', 'ghcr', 'sourceforge']) {
        const api = require(`../${type}.js`);
        const p = project(owner, { type, origin: 'https://provider.example.invalid' });
        database.projects.update(p.id, { lastSuccessfulSyncAt: Date.now() });
        t.mock.method(api, 'getReleases', async () => [{ projectId: p.id, version: '1.0.0-beta', sha: 'fixture', prerelease: false, createdAt: Date.now() }]);
        if (api.getCommit) t.mock.method(api, 'getCommit', async () => ({ createdAt: new Date().toISOString(), message: 'fixture' }));
        if (api.getRelease) t.mock.method(api, 'getRelease', async () => ({ body: '', prerelease: false }));
        await tasks.syncReleasesByProject(database.users.get(owner.id), database.projects.get(p.id));
        assert.equal(database.releases.listPendingForProject(p.id).length, 1, type);
        database.releases.listPendingForProject(p.id).forEach(r => database.releases.update(r.id, { notified: true }));
    }
});

test('legacy API edits become explicit overrides and changing settings never rewrites history', async () => {
    const owner = user();
    const p = project(owner);
    const original = release(p, '1.0.0', false, { notified: true });
    const response = await request(routes.projects.update, owner, { excludePrereleases: true }, p.id);
    assert.equal(response.status, 202);
    assert.equal(database.projects.get(p.id).inheritReleaseFiltering, false);
    assert.equal(database.projects.get(p.id).effectiveExcludePrereleases, true);
    await request(routes.profile.update, owner, { defaultExcludePrereleases: false });
    assert.equal(database.projects.get(p.id).effectiveExcludePrereleases, true);
    assert.equal(database.releases.list(p.id)[0].id, original.id);
    assert.equal(database.releases.list(p.id)[0].notified, 1);
});

test('old promotions and re-released stable tags do not replay history', async t => {
    const owner = user();
    const p = project(owner, { excludePrereleases: true, excludeUpdated: true });
    database.projects.update(p.id, { lastSuccessfulSyncAt: Date.now() });
    release(p, '1.0.0', true, { notified: true, createdAt: Date.now() - 30 * 24 * 3600 * 1000 });
    release(p, '2.0.0', false, { notified: true, sha: 'old-sha' });
    mockGithub(t, [{ version: '1.0.0' }, { version: '2.0.0', sha: 'changed-sha' }], { '1.0.0': { body: '', prerelease: false } });
    await tasks.syncReleasesByProject(owner, database.projects.get(p.id));
    assert.equal(database.releases.listPendingForProject(p.id).length, 0);
    assert.equal(database.releases.list(p.id).length, 2);
});
