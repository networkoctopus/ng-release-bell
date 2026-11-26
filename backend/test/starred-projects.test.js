'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the actual Vue methods without mounting unrelated UI components.
function loadEditor() {
    const source = fs.readFileSync(path.join(__dirname, '../../frontend/App.vue'), 'utf8').split('<script>')[1].split('</script>')[0]
        .replace(/^import .*;\s*$/gm, '').replace('export default', 'module.exports =')
        .replace(/import\.meta\.env\.VITE_API_ORIGIN/g, '\'\'');
    const context = { module: { exports: {} }, superagent: { get: async () => ({ body: { releases: [] } }), post: () => ({ send: async data => { context.sent = data; } }) }, Button: {}, Dropdown: {}, DataTable: {}, Column: {}, InputSwitch: {}, ConfirmPopup: {}, MainLayout: {}, TopBar: {}, BottomBar: {}, console };
    vm.runInNewContext(source, context);
    return { methods: context.module.exports.methods, context };
}

test('editing a starred subscription preserves identity and repeated sync preserves preferences/history', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'releasebell-stars-'));
    process.env.DB_PATH = path.join(dir, 'test.db');
    process.env.DATA_DIR = dir;
    fs.writeFileSync(path.join(dir, 'session.secret'), 'isolated-test-secret');
    delete process.env.MAIL_SMTP_SERVER;
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const database = require('../database.js');
    const github = require('../github.js');
    const tasks = require('../tasks.js');
    const routes = require('../routes.js');
    database.init();
    const user = database.users.add({ id: 'test-user', email: 'test@example.invalid', githubToken: 'mock' });
    user.githubAutoImport = true;
    let starred = [{ full_name: 'owner/repo' }];
    t.mock.method(github, 'getStarred', async () => starred);
    t.mock.method(github, 'getReleases', async () => []);
    await tasks.syncGithubStarredByUser(user);
    const original = database.projects.list(user.id)[0];
    database.releases.add({ projectId: original.id, version: 'v1', body: 'preserve me', notified: true });

    const { methods, context } = loadEditor();
    const editor = { availableProjectTypes: [{ type: 'github_manual', name: 'Github' }], editProjectDialog: {}, loadProjects: async () => {} };
    await methods.onShowEditProjectDialog.call(editor, original);
    editor.editProjectDialog.emailFrequency = 'weekly';
    editor.editProjectDialog.excludePrereleases = true;
    // Submission refreshes project data after saving.
    editor.refresh = async () => {};
    await methods.onEditProjectSubmit.call(editor);
    assert.equal(context.sent.type, 'github');
    let response;
    await routes.projects.update({ user, params: { projectId: original.id }, body: context.sent }, {}, result => { response = result; });
    assert.equal(response.status, 202);
    await tasks.syncGithubStarredByUser(user);
    await tasks.syncGithubStarredByUser(user);
    const projects = database.projects.list(user.id);
    assert.equal(projects.length, 1);
    assert.equal(projects[0].id, original.id);
    assert.equal(projects[0].emailFrequency, 'weekly');
    assert.equal(projects[0].excludePrereleases, true);
    assert.equal(database.releases.list(original.id)[0].body, 'preserve me');
    assert.equal(database.projects.add({ userId: user.id, type: 'github', name: 'OWNER/REPO' }).id, original.id);

    await routes.projects.update({ user, params: { projectId: original.id }, body: { type: 'github_manual' } }, {}, result => { response = result; });
    assert.equal(response.status, 400);
    assert.equal(database.projects.get(original.id).type, 'github');

    const manual = database.projects.add({ userId: user.id, type: 'github_manual', name: 'owner/manual' });
    starred.push({ full_name: 'owner/manual' });
    await tasks.syncGithubStarredByUser(user);
    assert.equal(database.projects.list(user.id).length, 2);
    starred = [];
    await tasks.syncGithubStarredByUser(user);
    assert.deepEqual(database.projects.list(user.id).map(p => p.id), [manual.id]);
    assert.equal(database.releases.list(original.id).length, 0);
    user.githubAutoImport = false;
    starred = [{ full_name: 'owner/disabled' }];
    await tasks.syncGithubStarredByUser(user);
    assert.equal(database.projects.list(user.id).length, 1);
});
