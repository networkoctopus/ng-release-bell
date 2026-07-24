'use strict';

const safeRegex = require('safe-regex');

function validateRegex(pattern) {
    if (!pattern || typeof pattern !== 'string' || pattern.length === 0) return { valid: true };
    try {
        const re = new RegExp(pattern);
        if (!safeRegex(re)) {
            return { valid: false, error: 'This regex pattern is potentially catastrophic (ReDoS risk). Please simplify it.' };
        }
        return { valid: true };
    } catch (e) {
        return { valid: false, error: 'Invalid regex: ' + e.message };
    }
}

function validateVersionFilters(versionFilters) {
    if (!versionFilters) return { valid: true };
    const filters = typeof versionFilters === 'string' ? JSON.parse(versionFilters) : versionFilters;
    for (const f of filters) {
        const result = validateRegex(f.value);
        if (!result.valid) return { valid: false, error: `Invalid regex filter "${f.value}": ${result.error}` };
    }
    return { valid: true };
}

function passesVersionFilters(version, versionFilters) {
    if (!versionFilters) return true;
    const filters = typeof versionFilters === 'string' ? JSON.parse(versionFilters) : versionFilters;
    const includes = filters.filter(f => f.inverse === true);
    const excludes = filters.filter(f => f.inverse === false);

    if (includes.length > 0 && !includes.some(f => {
        if (!f.value) return false;
        try {
            const re = new RegExp(f.value);
            if (!safeRegex(re)) return false;
            return re.test(version);
        } catch (e) { return false; }
    })) return false;

    if (excludes.some(f => {
        if (!f.value) return false;
        try {
            const re = new RegExp(f.value);
            if (!safeRegex(re)) return false;
            return re.test(version);
        } catch (e) { return false; }
    })) return false;

    return true;
}

const NON_SEMVER_TAGS = ['latest', 'stable', 'develop', 'main', 'master', 'edge', 'nightly'];

const SEMVER_CORE_RE = /^(?:v)?(\d+)\.(\d+)\.(\d+)/;

function extractSemverCore(version) {
    if (!version || typeof version !== 'string') return null;
    const m = version.match(SEMVER_CORE_RE);
    if (!m) return null;
    return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}

function compareCores(a, b) {
    if (a[0] !== b[0]) return a[0] - b[0];
    if (a[1] !== b[1]) return a[1] - b[1];
    return a[2] - b[2];
}

function computeMaxSemverCore(versions) {
    let max = null;
    for (const v of versions) {
        const core = extractSemverCore(v);
        if (!core) continue;
        if (!max || compareCores(core, max) > 0) max = core;
    }
    return max;
}

function isLatestVersion(version, maxCore) {
    if (!maxCore) return false;
    const core = extractSemverCore(version);
    if (!core) return false;
    return compareCores(core, maxCore) === 0;
}

function filterLatestVersionOnly(releases) {
    const maxCore = computeMaxSemverCore(releases.map(r => r.version));
    return releases.filter(r => isLatestVersion(r.version, maxCore));
}

function releasePassesDisplayFilters(release, project) {
    if (NON_SEMVER_TAGS.includes(release.version.toLowerCase())) return false;
    if (!passesVersionFilters(release.version, project.versionFilters)) return false;
    if (project.excludePrereleases && release.prerelease) return false;
    return true;
}

module.exports = {
    validateRegex,
    validateVersionFilters,
    passesVersionFilters,
    releasePassesDisplayFilters,
    extractSemverCore,
    computeMaxSemverCore,
    isLatestVersion,
    filterLatestVersionOnly,
    NON_SEMVER_TAGS
};