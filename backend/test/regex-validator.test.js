'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    validateVersionFilters,
    passesVersionFilters,
    releasePassesDisplayFilters,
    extractSemverCore,
    computeMaxSemverCore,
    isLatestVersion,
    filterLatestVersionOnly,
    NON_SEMVER_TAGS
} = require('../regex-validator.js');

function makeProject(overrides = {}) {
    return {
        versionFilters: null,
        excludePrereleases: false,
        ...overrides
    };
}

test('NON_SEMVER_TAGS contains the expected set', () => {
    for (const tag of ['latest', 'stable', 'develop', 'main', 'master', 'edge', 'nightly']) {
        assert.ok(NON_SEMVER_TAGS.includes(tag), `${tag} should be a non-semver tag`);
    }
});

test('passesVersionFilters: no filters passes everything', () => {
    assert.equal(passesVersionFilters('v1.0.0', null), true);
    assert.equal(passesVersionFilters('v1.0.0', undefined), true);
    assert.equal(passesVersionFilters('v1.0.0', []), true);
    assert.equal(passesVersionFilters('v1.0.0', '[]'), true);
});

test('passesVersionFilters: include regex keeps only matching versions', () => {
    const filters = [{ value: '^v?\\d+\\.\\d+\\.\\d+$', inverse: true }];
    assert.equal(passesVersionFilters('1.2.3', filters), true);
    assert.equal(passesVersionFilters('v1.2.3', filters), true);
    assert.equal(passesVersionFilters('nightly', filters), false);
    assert.equal(passesVersionFilters('1.2.3-rc.1', filters), false);
});

test('passesVersionFilters: exclude regex drops matching versions', () => {
    const filters = [{ value: '-rc\\.\\d+', inverse: false }];
    assert.equal(passesVersionFilters('1.2.3', filters), true);
    assert.equal(passesVersionFilters('1.2.3-rc.1', filters), false);
});

test('passesVersionFilters: include + exclude combine (all includes must match, no exclude may match)', () => {
    const filters = [
        { value: '^\\d', inverse: true },
        { value: '-beta', inverse: false }
    ];
    assert.equal(passesVersionFilters('1.0.0', filters), true);
    assert.equal(passesVersionFilters('1.0.0-beta.1', filters), false);
    assert.equal(passesVersionFilters('v1.0.0', filters), false);
});

test('passesVersionFilters: invalid regex in filter is treated as non-matching (no throw)', () => {
    const include = [{ value: '(unclosed', inverse: true }];
    assert.equal(passesVersionFilters('1.0.0', include), false);
    const exclude = [{ value: '(unclosed', inverse: false }];
    assert.equal(passesVersionFilters('1.0.0', exclude), true);
});

test('passesVersionFilters: empty filter value is treated as non-matching', () => {
    const include = [{ value: '', inverse: true }];
    assert.equal(passesVersionFilters('1.0.0', include), false);
    const exclude = [{ value: '', inverse: false }];
    assert.equal(passesVersionFilters('1.0.0', exclude), true);
});

test('validateVersionFilters: null/undefined is valid', () => {
    assert.deepEqual(validateVersionFilters(null), { valid: true });
    assert.deepEqual(validateVersionFilters(undefined), { valid: true });
});

test('validateVersionFilters: valid patterns pass', () => {
    assert.deepEqual(validateVersionFilters([{ value: '^v\\d+$', inverse: true }]), { valid: true });
    assert.deepEqual(validateVersionFilters(JSON.stringify([{ value: '^v\\d+$', inverse: true }])), { valid: true });
});

test('validateVersionFilters: invalid regex returns error', () => {
    const res = validateVersionFilters([{ value: '(unclosed', inverse: true }]);
    assert.equal(res.valid, false);
    assert.match(res.error, /Invalid regex/);
});

test('releasePassesDisplayFilters: rejects NON_SEMVER_TAGS regardless of case', () => {
    const project = makeProject();
    assert.equal(releasePassesDisplayFilters({ version: 'LATEST', prerelease: false }, project), false);
    assert.equal(releasePassesDisplayFilters({ version: 'Nightly', prerelease: false }, project), false);
});

test('releasePassesDisplayFilters: rejects version failing include regex', () => {
    const project = makeProject({ versionFilters: [{ value: '^\\d+\\.\\d+\\.\\d+$', inverse: true }] });
    assert.equal(releasePassesDisplayFilters({ version: '1.2.3', prerelease: false }, project), true);
    assert.equal(releasePassesDisplayFilters({ version: 'some-branch', prerelease: false }, project), false);
});

test('releasePassesDisplayFilters: rejects prereleases when excludePrereleases is set', () => {
    const project = makeProject({ excludePrereleases: true });
    assert.equal(releasePassesDisplayFilters({ version: '1.0.0', prerelease: false }, project), true);
    assert.equal(releasePassesDisplayFilters({ version: '1.0.0-rc.1', prerelease: true }, project), false);
});

test('releasePassesDisplayFilters: keeps prereleases when excludePrereleases is off', () => {
    const project = makeProject({ excludePrereleases: false });
    assert.equal(releasePassesDisplayFilters({ version: '1.0.0-rc.1', prerelease: true }, project), true);
});

test('releasePassesDisplayFilters: non-semver tag still rejected even with matching include regex', () => {
    const project = makeProject({ versionFilters: [{ value: '.*', inverse: true }] });
    assert.equal(releasePassesDisplayFilters({ version: 'latest', prerelease: false }, project), false);
});

test('releasePassesDisplayFilters: all filters out -> false (the bug-fix scenario)', () => {
    const project = makeProject({ versionFilters: [{ value: '^v\\d', inverse: true }] });
    assert.equal(releasePassesDisplayFilters({ version: 'latest', prerelease: false }, project), false);
    assert.equal(releasePassesDisplayFilters({ version: 'main', prerelease: false }, project), false);
});

test('extractSemverCore: parses X.Y.Z prefix from tag with suffix', () => {
    assert.deepEqual(extractSemverCore('34.0.2-fpm'), [34, 0, 2]);
    assert.deepEqual(extractSemverCore('34.0.2-fpm-alpine'), [34, 0, 2]);
    assert.deepEqual(extractSemverCore('34.0.2'), [34, 0, 2]);
    assert.deepEqual(extractSemverCore('v1.2.3'), [1, 2, 3]);
});

test('extractSemverCore: returns null for non-semver tags', () => {
    assert.equal(extractSemverCore('stable-fpm'), null);
    assert.equal(extractSemverCore('34-fpm'), null);
    assert.equal(extractSemverCore('latest'), null);
    assert.equal(extractSemverCore(''), null);
    assert.equal(extractSemverCore(null), null);
});

test('computeMaxSemverCore: picks highest core ignoring non-semver', () => {
    const versions = ['34.0.2-fpm', '33.0.7-fpm', 'stable-fpm', '32.0.13-apache', '34.0.1'];
    assert.deepEqual(computeMaxSemverCore(versions), [34, 0, 2]);
});

test('computeMaxSemverCore: returns null when no semver tags', () => {
    assert.equal(computeMaxSemverCore(['stable-fpm', 'latest', '34-fpm']), null);
    assert.equal(computeMaxSemverCore([]), null);
});

test('isLatestVersion: true only for the max core', () => {
    const maxCore = [34, 0, 2];
    assert.equal(isLatestVersion('34.0.2-fpm', maxCore), true);
    assert.equal(isLatestVersion('34.0.2-apache', maxCore), true);
    assert.equal(isLatestVersion('34.0.2', maxCore), true);
    assert.equal(isLatestVersion('33.0.7-fpm', maxCore), false);
    assert.equal(isLatestVersion('34.0.1-fpm', maxCore), false);
    assert.equal(isLatestVersion('stable-fpm', maxCore), false);
});

test('isLatestVersion: false when maxCore is null', () => {
    assert.equal(isLatestVersion('34.0.2-fpm', null), false);
});

test('filterLatestVersionOnly: keeps only max-core variants, drops older patches', () => {
    const releases = [
        { version: '34.0.2-fpm' },
        { version: '34.0.2-apache' },
        { version: '33.0.7-fpm' },
        { version: '32.0.13-apache' },
        { version: 'stable-fpm' },
        { version: '34.0.1' }
    ];
    const result = filterLatestVersionOnly(releases);
    assert.equal(result.length, 2);
    assert.ok(result.find(r => r.version === '34.0.2-fpm'));
    assert.ok(result.find(r => r.version === '34.0.2-apache'));
});

test('filterLatestVersionOnly: drops non-semver tags when semver tags exist', () => {
    const releases = [
        { version: 'stable-fpm' },
        { version: '34.0.2-fpm' },
        { version: 'latest' }
    ];
    const result = filterLatestVersionOnly(releases);
    assert.equal(result.length, 1);
    assert.equal(result[0].version, '34.0.2-fpm');
});

test('filterLatestVersionOnly: empty input yields empty output', () => {
    assert.deepEqual(filterLatestVersionOnly([]), []);
});

test('filterLatestVersionOnly: all non-semver yields empty (no max core)', () => {
    const releases = [{ version: 'stable-fpm' }, { version: 'latest' }];
    assert.deepEqual(filterLatestVersionOnly(releases), []);
});

test('filterLatestVersionOnly: the nextcloud repush scenario', () => {
    const releases = [
        { version: '34.0.2-fpm-alpine' },
        { version: '34.0.2-fpm' },
        { version: '34.0.2-apache' },
        { version: '34.0.2' },
        { version: '33.0.7-fpm-alpine' },
        { version: '33.0.7-fpm' },
        { version: '33.0.7-apache' },
        { version: '33.0.7' }
    ];
    const result = filterLatestVersionOnly(releases);
    assert.equal(result.length, 4);
    const kept = result.map(r => r.version).sort();
    assert.deepEqual(kept, ['34.0.2', '34.0.2-apache', '34.0.2-fpm', '34.0.2-fpm-alpine']);
});