'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createServer } = require('node:net');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

for (const upgrade of [false, true]) {
    test(`HTTP application ${upgrade ? 'SQLite upgrade' : 'fresh install'} and restart retain preferences, history and session`, async t => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'releasebell-server-'));
        const dbPath = path.join(dir, 'test.db');
        const portReservation = createServer();
        portReservation.listen(0, '127.0.0.1');
        await once(portReservation, 'listening');
        const port = portReservation.address().port;
        await new Promise(resolve => portReservation.close(resolve));
        if (upgrade) {
            const old = new DatabaseSync(dbPath);
            old.exec(fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf8')
                .replace(/,\n {4}defaultExcludePrereleases INTEGER NOT NULL DEFAULT 0/, '')
                .replace(/ {4}inheritReleaseFiltering INTEGER NOT NULL DEFAULT 0,\n/, ''));
            old.exec(`INSERT INTO users (id,email) VALUES ('legacy','test@example.invalid');
                INSERT INTO projects (id,userId,name,type,excludePrereleases) VALUES ('old','legacy','old/project','website',1);
                INSERT INTO releases (id,projectId,version,notified) VALUES ('history','old','1.0.0',1)`);
            old.close();
        }
        const password = 'isolated-http-test-password';
        const env = { ...process.env, NODE_ENV: 'production', DB_PATH: dbPath, DATA_DIR: dir, PORT: String(port), ADMIN_PASSWORD: password,
            ADMIN_EMAIL: 'test@example.invalid', GITHUB_TOKEN: '', QUAY_TOKEN: '', OIDC_ISSUER: '', OIDC_CLIENT_ID: '', OIDC_CLIENT_SECRET: '',
            MAIL_SMTP_SERVER: '', MAIL_SMTP_PORT: '', MAIL_SMTP_USERNAME: '', MAIL_SMTP_PASSWORD: '', MAIL_FROM: '', APP_ORIGIN: '' };
        let child;
        let logs = '';
        let cookie = '';
        const stop = async () => {
            if (child && child.exitCode === null && child.signalCode === null) {
                const exited = once(child, 'exit');
                child.kill('SIGTERM');
                await exited;
            }
        };
        t.after(async () => { await stop(); fs.rmSync(dir, { recursive: true, force: true }); });
        async function request(endpoint, body) {
            const response = await fetch(`http://127.0.0.1:${port}/api/v1/${endpoint}`, {
                method: body === undefined ? 'GET' : 'POST',
                headers: { 'content-type': 'application/json', cookie },
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: AbortSignal.timeout(1000)
            });
            return { status: response.status, cookie: response.headers.get('set-cookie'), body: await response.json() };
        }
        async function start() {
            child = spawn(process.execPath, ['index.js'], { cwd: path.join(__dirname, '../..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
            child.stdout.on('data', chunk => { logs += chunk; });
            child.stderr.on('data', chunk => { logs += chunk; });
            for (let attempt = 0; attempt < 60; attempt++) {
                try {
                    const status = await request('status');
                    if (status.status === 200 && status.body.db) return;
                } catch { /* wait for startup */ }
                if (child.exitCode !== null) throw new Error(logs);
                await delay(50);
            }
            throw new Error('Server startup timeout: ' + logs);
        }
        await start();
        const login = await request('login', { password });
        assert.equal(login.status, 200);
        cookie = login.cookie.split(';')[0];
        if (upgrade) {
            const old = (await request('projects')).body.projects[0];
            assert.equal(old.inheritReleaseFiltering, false);
            assert.equal(old.excludePrereleases, true);
        }
        assert.equal((await request('profile', { defaultExcludePrereleases: true })).status, 202);
        // website is an existing accepted project type with no provider adapter:
        // it exercises persistence/API paths without any external provider calls.
        const created = await request('projects', { name: 'new/project', type: 'website' });
        assert.equal(created.status, 201);
        assert.equal(created.body.project.effectiveExcludePrereleases, true);
        await stop();
        await start();
        const profile = await request('profile');
        assert.equal(profile.status, 200, 'saved session remains valid');
        assert.equal(!!profile.body.user.defaultExcludePrereleases, true);
        const projects = (await request('projects')).body.projects;
        assert.equal(projects.find(p => p.name === 'new/project').inheritReleaseFiltering, true);
        const exported = (await request('data/export')).body;
        assert.equal(exported.settings.defaultExcludePrereleases, true);
        if (upgrade) {
            const copy = new DatabaseSync(dbPath, { readOnly: true });
            assert.equal(copy.prepare('SELECT count(*) AS n FROM releases WHERE id=\'history\' AND notified=1').get().n, 1);
            copy.close();
        }
    });
}
