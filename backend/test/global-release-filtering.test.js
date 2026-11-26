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

test('v3 export/import preserves global settings, inheritance, overrides and disabled projects; v1 stays explicit', async t => {
    mockGithub(t, []);
    const owner = user();
    await request(routes.profile.update, owner, { defaultExcludePrereleases: true });
    project(owner);
    project(owner, { excludePrereleases: false, enabled: false });
    const exported = await request(routes.data.export, owner, {});
    assert.equal(exported.body.version, 3);
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
    const context = { module: { exports: {} }, superagent: { get: async () => ({ body: { releases: [] } }), post: () => ({ send: async data => { context.sent = data; } }) }, Button: {}, Dropdown: {}, DataTable: {}, Column: {}, InputSwitch: {}, ConfirmPopup: {}, MainLayout: {}, TopBar: {}, BottomBar: {}, console };
    vm.runInNewContext(source, context);
    const app = context.module.exports;
    const editor = { user: { defaultExcludePrereleases: 1, defaultExcludeUpdated: 1, defaultLatestVersionOnly: 1 }, availableProjectTypes: [{ type: 'github_manual' }], editProjectDialog: {} };
    await app.methods.onShowEditProjectDialog.call(editor, { id: 'fixture', type: 'github_manual', name: 'owner/repo', inheritReleaseFiltering: true, inheritExcludeUpdated: true, inheritLatestVersionOnly: true });
    assert.equal(editor.editProjectDialog.releaseFiltering, 'inherit');
    assert.equal(editor.editProjectDialog.excludeUpdated, 'inherit');
    assert.equal(editor.editProjectDialog.latestVersionOnly, 'inherit');
    editor.editProjectDialog.releases = [{ version: 'v2.0.0-beta', prerelease: true }, { version: 'v1.0.0', prerelease: false }];
    assert.equal(app.computed.filteredReleasesPreview.call(editor)[0]._excluded, true);
    editor.editProjectDialog.releaseFiltering = 'all';
    assert.equal(app.computed.filteredReleasesPreview.call(editor)[0]._excluded, false);
    editor.editProjectDialog.releases = [
        { version: '3.0.0', updated: 1 }, { version: '2.0.0' }, { version: '1.0.0' }
    ];
    assert.equal(app.computed.filteredReleasesPreview.call(editor).every(r => r._excluded), true);
    editor.editProjectDialog.excludeUpdated = false;
    assert.equal(app.computed.filteredReleasesPreview.call(editor)[0]._excluded, false);
    editor.editProjectDialog.latestVersionOnly = false;
    assert.equal(app.computed.filteredReleasesPreview.call(editor)[2]._excluded, false);
    editor.refresh = async () => {};
    editor.editProjectDialog.excludeUpdated = 'inherit';
    editor.editProjectDialog.latestVersionOnly = 'inherit';
    await app.methods.onEditProjectSubmit.call(editor);
    assert.equal(context.sent.inheritExcludeUpdated, true);
    assert.equal(context.sent.inheritLatestVersionOnly, true);
    editor.editProjectDialog.excludeUpdated = true;
    editor.editProjectDialog.latestVersionOnly = false;
    await app.methods.onEditProjectSubmit.call(editor);
    assert.equal(context.sent.inheritExcludeUpdated, false);
    assert.equal(context.sent.excludeUpdated, true);
    assert.equal(context.sent.inheritLatestVersionOnly, false);
    assert.equal(context.sent.latestVersionOnly, false);
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

test('updated and latest defaults inherit independently, with overrides in both directions and legacy API support', async t => {
    const owner = user();
    const other = user();
    const fresh = project(owner);
    const otherProject = project(other);
    assert.equal(fresh.inheritExcludeUpdated, true);
    assert.equal(fresh.inheritLatestVersionOnly, true);
    assert.equal(fresh.effectiveExcludeUpdated, false);
    assert.equal(fresh.effectiveLatestVersionOnly, false);
    const response = await request(routes.profile.update, owner, { defaultExcludeUpdated: true, defaultLatestVersionOnly: true });
    assert.equal(response.status, 202);
    assert.equal(database.projects.get(fresh.id).effectiveExcludeUpdated, true);
    assert.equal(database.projects.get(fresh.id).effectiveLatestVersionOnly, true);
    assert.equal(database.projects.get(otherProject.id).effectiveExcludeUpdated, false);
    const explicitNo = project(owner, { excludeUpdated: false, latestVersionOnly: false });
    const explicitYes = project(owner, { excludeUpdated: true, latestVersionOnly: true });
    assert.equal(explicitNo.inheritExcludeUpdated, false);
    assert.equal(explicitNo.effectiveLatestVersionOnly, false);
    await request(routes.projects.update, owner, { excludeUpdated: false }, fresh.id);
    assert.equal(database.projects.get(fresh.id).inheritExcludeUpdated, false);
    assert.equal(database.projects.get(fresh.id).inheritLatestVersionOnly, true);
    await request(routes.profile.update, owner, { defaultExcludeUpdated: false, defaultLatestVersionOnly: false });
    assert.equal(database.projects.get(explicitYes.id).effectiveExcludeUpdated, true);
    assert.equal(database.projects.get(explicitYes.id).effectiveLatestVersionOnly, true);
    await request(routes.projects.update, owner, { inheritExcludeUpdated: true, latestVersionOnly: true }, fresh.id);
    assert.equal(database.projects.get(fresh.id).effectiveExcludeUpdated, false);
    assert.equal(database.projects.get(fresh.id).inheritLatestVersionOnly, false);
    t.mock.method(github, 'getStarred', async () => [{ full_name: 'owner/new-defaults-star' }]);
    mockGithub(t, []);
    await tasks.syncGithubStarredByUser({ ...database.users.get(owner.id), githubAutoImport: true });
    const star = database.projects.listByType(owner.id, 'github')[0];
    assert.equal(star.inheritExcludeUpdated, true);
    assert.equal(star.inheritLatestVersionOnly, true);
    const created = await request(routes.projects.add, owner, { type: 'github_manual', name: 'owner/explicit-api', excludeUpdated: true, latestVersionOnly: true });
    assert.equal(created.body.project.inheritExcludeUpdated, false);
    assert.equal(created.body.project.effectiveLatestVersionOnly, true);
    for (const field of ['defaultExcludeUpdated', 'defaultLatestVersionOnly']) {
        assert.equal((await request(routes.profile.update, owner, { [field]: 'false' })).status, 400);
    }
    for (const field of ['inheritExcludeUpdated', 'inheritLatestVersionOnly', 'excludeUpdated', 'latestVersionOnly']) {
        assert.equal((await request(routes.projects.update, owner, { [field]: null }, fresh.id)).status, 400);
        assert.equal((await request(routes.projects.add, owner, { type: 'github_manual', name: 'invalid', [field]: 'false' })).status, 400);
    }
    release(explicitYes, '1.0.0', false, { notified: true });
    const history = database.releases.list(explicitYes.id);
    await request(routes.profile.update, owner, { makeProjectsInherit: true });
    assert.equal(database.projects.list(owner.id).every(p => p.inheritReleaseFiltering && p.inheritExcludeUpdated && p.inheritLatestVersionOnly), true);
    assert.equal(database.projects.get(otherProject.id).effectiveExcludeUpdated, false);
    assert.deepEqual(database.releases.list(explicitYes.id), history);
});

test('global latest-version filtering uses stable eligibility, regex, explicit overrides and current queued preferences', async t => {
    const owner = user();
    await request(routes.profile.update, owner, { defaultExcludePrereleases: true, defaultLatestVersionOnly: true });
    const inherited = project(owner, { versionFilters: JSON.stringify([{ value: '^v[123]', inverse: true }]) });
    const override = project(owner, { latestVersionOnly: false });
    mockGithub(t, [
        { version: 'v4.0.0', sha: 'regex-excluded' },
        { version: 'v3.0.0-beta', sha: 'prerelease-excluded' },
        { version: 'v2.0.0', sha: 'latest-stable' },
        { version: 'v1.0.0', sha: 'older-stable' }
    ], { 'v3.0.0-beta': { body: '', prerelease: true } });
    for (const p of [inherited, override]) {
        database.projects.update(p.id, { lastSuccessfulSyncAt: Date.now() });
        await tasks.syncReleasesByProject(owner, p);
    }
    assert.deepEqual(database.releases.listPendingForProject(inherited.id).map(r => r.version), ['v2.0.0']);
    assert.equal(database.releases.listPendingForProject(override.id).length, 3);
    database.releases.listPendingForProject(inherited.id).concat(database.releases.listPendingForProject(override.id)).forEach(r => database.releases.update(r.id, { notified: true }));
    const queued = project(owner);
    await request(routes.profile.update, owner, { defaultLatestVersionOnly: false });
    release(queued, '1.0.0', false, { createdAt: Date.now() + 1000 });
    release(queued, '2.0.0', false);
    assert.equal(database.projects.list(owner.id).find(p => p.id === queued.id).version, '1.0.0');
    await request(routes.profile.update, owner, { defaultLatestVersionOnly: true });
    assert.equal(database.projects.list(owner.id).find(p => p.id === queued.id).version, '2.0.0');
    assert.equal(database.projects.listByType(owner.id, queued.type).find(p => p.id === queued.id).version, '2.0.0');
    const sent = [];
    t.mock.method(nodemailer, 'createTransport', () => ({ sendMail: async mail => { sent.push(mail); } }));
    await tasks.sendNotifications();
    assert.equal(sent.length, 1);
    assert.match(sent[0].subject, /2\.0\.0 released/);
    await request(routes.profile.update, owner, { defaultLatestVersionOnly: false });
    await tasks.sendNotifications();
    assert.equal(sent.length, 1, 'widening must not replay consumed older versions');
});

test('global updated-release exclusion detects changed SHA, preserves row identity, and does not replay after preference changes', async t => {
    const owner = user();
    await request(routes.profile.update, owner, { defaultExcludeUpdated: true });
    const inherited = project(owner);
    const allow = project(owner, { excludeUpdated: false });
    const exclude = project(owner, { excludeUpdated: true });
    const originals = new Map();
    mockGithub(t, [{ version: '2.0.0', sha: 'new-sha' }]);
    for (const p of [inherited, allow, exclude]) {
        database.projects.update(p.id, { lastSuccessfulSyncAt: Date.now() });
        originals.set(p.id, release(p, '2.0.0', false, { notified: true, sha: 'old-sha' }));
        await tasks.syncReleasesByProject(owner, p);
        const stored = database.releases.list(p.id);
        assert.equal(stored.length, 1);
        assert.equal(stored[0].id, originals.get(p.id).id);
        assert.equal(stored[0].sha, 'new-sha');
        assert.equal(stored[0].updated, 1);
    }
    assert.equal(database.releases.listPendingForProject(inherited.id).length, 0);
    assert.equal(database.releases.listPendingForProject(allow.id).length, 1);
    assert.equal(database.releases.listPendingForProject(exclude.id).length, 0);
    const sent = [];
    t.mock.method(nodemailer, 'createTransport', () => ({ sendMail: async mail => { sent.push(mail); } }));
    await tasks.sendNotifications();
    assert.equal(sent.length, 1);
    await request(routes.profile.update, owner, { defaultExcludeUpdated: false });
    for (const p of [inherited, allow, exclude]) await tasks.syncReleasesByProject(owner, p);
    await tasks.sendNotifications();
    assert.equal(sent.length, 1, 'unchanged SHA and widened settings must not resend old updates');
    const queued = project(owner);
    database.projects.update(queued.id, { lastSuccessfulSyncAt: Date.now() });
    release(queued, '2.0.0', false, { notified: true, sha: 'old-sha' });
    await tasks.syncReleasesByProject(owner, queued);
    assert.equal(database.releases.listPendingForProject(queued.id).length, 1);
    await request(routes.profile.update, owner, { defaultExcludeUpdated: true });
    await tasks.sendNotifications();
    assert.equal(database.releases.listPendingForProject(queued.id).length, 0);
    assert.equal(sent.length, 1, 'queued updates must respect the current inherited default');
    await request(routes.profile.update, owner, { defaultExcludeUpdated: false });
    await tasks.sendNotifications();
    assert.equal(sent.length, 1);
});

test('changed prerelease promoted to stable bypasses update suppression and retains its row', async t => {
    const owner = user();
    await request(routes.profile.update, owner, { defaultExcludePrereleases: true, defaultExcludeUpdated: true, defaultLatestVersionOnly: true });
    const p = project(owner);
    database.projects.update(p.id, { lastSuccessfulSyncAt: Date.now() });
    const original = release(p, '2.0.0', true, { notified: true, sha: 'old-sha' });
    mockGithub(t, [{ version: '2.0.0', sha: 'stable-sha' }]);
    await tasks.syncReleasesByProject(owner, p);
    const stable = database.releases.list(p.id)[0];
    assert.equal(stable.id, original.id);
    assert.equal(stable.prerelease, 0);
    assert.equal(stable.updated, 0);
    assert.equal(stable.notified, 0);
    const sent = [];
    t.mock.method(nodemailer, 'createTransport', () => ({ sendMail: async mail => { sent.push(mail); } }));
    await tasks.sendNotifications();
    await tasks.syncReleasesByProject(owner, p);
    await tasks.sendNotifications();
    assert.equal(sent.length, 1);
});

test('v3 roundtrip retains independent inheritance; v2 imports keep explicit updated/latest values', async t => {
    mockGithub(t, []);
    const owner = user();
    await request(routes.profile.update, owner, { defaultExcludeUpdated: true, defaultLatestVersionOnly: true });
    project(owner);
    project(owner, { excludeUpdated: false, latestVersionOnly: false });
    project(owner, { excludeUpdated: true });
    const exported = (await request(routes.data.export, owner, {})).body;
    assert.equal(exported.version, 3);
    assert.equal(exported.settings.defaultExcludeUpdated, true);
    assert.equal(exported.settings.defaultLatestVersionOnly, true);
    const target = user();
    await request(routes.data.import, target, exported);
    const restored = database.projects.list(target.id);
    for (const original of database.projects.list(owner.id)) {
        const copy = restored.find(p => p.name === original.name);
        for (const field of ['excludeUpdated', 'latestVersionOnly', 'inheritExcludeUpdated', 'inheritLatestVersionOnly', 'effectiveExcludeUpdated', 'effectiveLatestVersionOnly']) assert.equal(copy[field], original[field], field);
    }
    await request(routes.data.import, target, { version: 2, settings: { defaultExcludePrereleases: false }, projects: [
        { name: 'v2/inherited-pre', type: 'github_manual', inheritReleaseFiltering: true, excludeUpdated: false, latestVersionOnly: true }
    ] });
    const legacy = database.projects.list(target.id).find(p => p.name === 'v2/inherited-pre');
    assert.equal(legacy.inheritReleaseFiltering, true);
    assert.equal(legacy.inheritExcludeUpdated, false);
    assert.equal(legacy.effectiveExcludeUpdated, false);
    assert.equal(legacy.inheritLatestVersionOnly, false);
    assert.equal(legacy.effectiveLatestVersionOnly, true);
    assert.equal(database.users.get(target.id).defaultExcludeUpdated, 1, 'v2 import leaves unspecified new defaults alone');
    const invalid = await request(routes.data.import, target, { projects: [{ name: 'invalid', type: 'github_manual', inheritLatestVersionOnly: 'true' }] });
    assert.equal(invalid.status, 400);
});

test('upgrading the previously shipped global-filtering schema preserves existing choices and history', () => {
    const dbPath = path.join(dir, 'v2-upgrade.db');
    const old = new DatabaseSync(dbPath);
    old.exec(fs.readFileSync(path.join(__dirname, 'fixtures/schema-v2.sql'), 'utf8'));
    old.exec('CREATE TABLE _migrations (name TEXT PRIMARY KEY NOT NULL, appliedAt TEXT NOT NULL)');
    for (const file of fs.readdirSync(path.join(__dirname, '../../migrations')).filter(f => f.endsWith('.js') && f !== '20261126200000-add-global-notification-filters.js').sort()) {
        require(path.join(__dirname, '../../migrations', file)).up(old);
        old.prepare('INSERT INTO _migrations VALUES (?, ?)').run(file, '2026-11-26');
    }
    old.exec(`INSERT INTO users (id,email,defaultExcludePrereleases) VALUES ('v2','test@example.invalid',1);
        INSERT INTO projects (id,userId,name,inheritReleaseFiltering,excludeUpdated,latestVersionOnly) VALUES ('old','v2','owner/repo',1,1,1);
        INSERT INTO releases (id,projectId,version,notified,sha) VALUES ('history','old','1.0.0',1,'preserve-sha')`);
    require('../migrator.js').runMigrations(old);
    require('../migrator.js').runMigrations(old);
    require('../../migrations/20261126200000-add-global-notification-filters.js').up(old);
    const p = old.prepare('SELECT * FROM projects').get();
    assert.equal(p.inheritReleaseFiltering, 1);
    assert.equal(p.inheritExcludeUpdated, 0);
    assert.equal(p.inheritLatestVersionOnly, 0);
    assert.equal(p.excludeUpdated, 1);
    assert.equal(p.latestVersionOnly, 1);
    const r = old.prepare('SELECT * FROM releases').get();
    assert.equal(r.id, 'history');
    assert.equal(r.notified, 1);
    assert.equal(r.updated, 0);
    assert.equal(r.sha, 'preserve-sha');
    old.close();
    const reopened = spawnSync(process.execPath, ['-e', 'const db=require(\'./backend/database.js\');db.init();console.log(JSON.stringify(db.projects.get(\'old\')))'], { cwd: path.join(__dirname, '../..'), env: { ...process.env, DB_PATH: dbPath }, encoding: 'utf8' });
    assert.equal(reopened.status, 0, reopened.stderr);
    assert.match(reopened.stdout, /"effectiveExcludeUpdated":true/);
    assert.match(reopened.stdout, /"effectiveLatestVersionOnly":true/);
});
