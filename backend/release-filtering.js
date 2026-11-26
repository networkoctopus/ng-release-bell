'use strict';

// Each preference has an independent inheritance flag, so an override for one
// filter does not opt the project out of the other global defaults.
const FILTER_PREFERENCES = [
    { field: 'excludePrereleases', defaultField: 'defaultExcludePrereleases', inheritField: 'inheritReleaseFiltering', effectiveField: 'effectiveExcludePrereleases' },
    { field: 'excludeUpdated', defaultField: 'defaultExcludeUpdated', inheritField: 'inheritExcludeUpdated', effectiveField: 'effectiveExcludeUpdated' },
    { field: 'latestVersionOnly', defaultField: 'defaultLatestVersionOnly', inheritField: 'inheritLatestVersionOnly', effectiveField: 'effectiveLatestVersionOnly' }
];

const PROJECT_FILTER_FIELDS = FILTER_PREFERENCES.flatMap(p => [p.field, p.inheritField]);

function effectiveReleaseFiltering(project) {
    return { ...project, ...Object.fromEntries(FILTER_PREFERENCES.map(p => [p.field, project[p.effectiveField]])) };
}

module.exports = { FILTER_PREFERENCES, PROJECT_FILTER_FIELDS, effectiveReleaseFiltering };
