'use strict';

// Run only against disposable containers/volumes created here. No host data,
// production environment variables, SMTP settings, or provider tokens are used.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const image = process.argv[2];
if (!image) throw new Error('Usage: node scripts/test-container.cjs IMAGE');
const suffix = randomUUID();
const container = `nrb-smoke-${suffix}`;
const volume = `nrb-smoke-${suffix}`;
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 60000 }).trim();
const mount = `type=volume,src=${volume},dst=/home/nonroot/data`;
const password = 'isolated-container-smoke-password';
let cookie = '';
async function api(path, body) {
    const script = `
        const request = JSON.parse(process.argv[1]);
        const result = await fetch('http://127.0.0.1:3000' + request.path, {
            method: request.body === undefined ? 'GET' : 'POST',
            headers: { 'content-type': 'application/json', cookie: request.cookie },
            body: request.body === undefined ? undefined : JSON.stringify(request.body),
            signal: AbortSignal.timeout(2000)
        });
        console.log(JSON.stringify({ status: result.status, cookie: result.headers.get('set-cookie'), body: await result.json() }));
    `;
    return JSON.parse(docker('exec', container, '/nodejs/bin/node', '--input-type=module', '-e', script, JSON.stringify({ path, body, cookie })));
}
async function healthy() {
    for (let attempt = 0; attempt < 40; attempt++) {
        try {
            const response = await api('/api/v1/status');
            if (response.status === 200 && response.body.db) return;
        } catch { /* startup or restart is still in progress */ }
        await delay(250);
    }
    throw new Error('Container did not become healthy');
}
async function scenario(upgrade) {
    docker('volume', 'create', volume);
    try {
        if (upgrade) {
            const seed = `
                const fs = require('node:fs');
                const { DatabaseSync } = require('node:sqlite');
                const db = new DatabaseSync(process.env.DB_PATH);
                const schema = fs.readFileSync('/app/backend/schema.sql', 'utf8')
                    .replace(/,\\n    defaultExcludePrereleases INTEGER NOT NULL DEFAULT 0/, '')
                    .replace(/    inheritReleaseFiltering INTEGER NOT NULL DEFAULT 0,\\n/, '');
                db.exec(schema);
                db.exec("INSERT INTO users (id,email) VALUES ('legacy','test@example.invalid')");
                db.exec("INSERT INTO projects (id,userId,name,type,excludePrereleases) VALUES ('old','legacy','old/project','website',1)");
                db.exec("INSERT INTO releases (id,projectId,version,notified) VALUES ('history','old','1.0.0',1)");
                db.close();
            `;
            docker('run', '--rm', '--network', 'none', '--mount', mount, '--entrypoint', '/nodejs/bin/node', image, '-e', seed);
        }
        docker('run', '-d', '--name', container, '--network', 'none', '--read-only', '--tmpfs', '/tmp', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--mount', mount, '-e', `ADMIN_PASSWORD=${password}`, image);
        await healthy();
        const login = await api('/api/v1/login', { password });
        assert.equal(login.status, 200);
        cookie = login.cookie.split(';')[0];
        const profile = await api('/api/v1/profile');
        assert.equal(!!profile.body.user.defaultExcludePrereleases, false);
        if (upgrade) {
            const projects = (await api('/api/v1/projects')).body.projects;
            assert.equal(projects[0].excludePrereleases, true);
            assert.equal(projects[0].inheritReleaseFiltering, false);
        }
        assert.equal((await api('/api/v1/profile', { defaultExcludePrereleases: true })).status, 202);
        const created = await api('/api/v1/projects', { type: 'website', name: 'new/project' });
        assert.equal(created.status, 201);
        assert.equal(created.body.project.inheritReleaseFiltering, true);
        assert.equal(created.body.project.effectiveExcludePrereleases, true);
        docker('restart', container);
        await healthy();
        // The session secret and database both survive restart.
        assert.equal((await api('/api/v1/profile')).status, 200);
        const exported = (await api('/api/v1/data/export')).body;
        assert.equal(exported.settings.defaultExcludePrereleases, true);
        assert.equal(exported.projects.find(p => p.name === 'new/project').inheritReleaseFiltering, true);
        if (upgrade) {
            const count = docker('exec', container, '/nodejs/bin/node', '-e', 'const {DatabaseSync}=require(\'node:sqlite\'); const db=new DatabaseSync(process.env.DB_PATH); console.log(db.prepare("SELECT count(*) AS n FROM releases WHERE id=\'history\' AND notified=1").get().n); db.close()');
            assert.equal(count, '1');
        }
        console.log(`${upgrade ? 'SQLite upgrade' : 'Fresh install'} + restart smoke test passed`);
    } catch (error) {
        try { console.error(docker('logs', container)); } catch { /* may not exist yet */ }
        throw error;
    } finally {
        try { docker('rm', '-f', container); } catch { /* may not exist yet */ }
        docker('volume', 'rm', volume);
        cookie = '';
    }
}
(async () => {
    await scenario(false);
    await scenario(true);
})().catch(error => { console.error(error); process.exitCode = 1; });
