'use strict';

exports.up = function(db) {
    for (const [table, column] of [
        ['users', 'defaultExcludeUpdated'],
        ['users', 'defaultLatestVersionOnly'],
        ['projects', 'inheritExcludeUpdated'],
        ['projects', 'inheritLatestVersionOnly'],
        ['releases', 'updated']
    ]) {
        if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column)) {
            db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
        }
    }
    // Keep existing booleans explicit, including installations already using
    // global prerelease inheritance. Only newly added projects inherit by default.
};
