'use strict';

exports.up = function(db) {
    const addColumnIfMissing = (table, column, definition) => {
        if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column)) {
            db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
        }
    };
    // Keep every existing project preference explicit. New projects opt into
    // inheritance through projects.add, rather than rewriting old preferences.
    addColumnIfMissing('users', 'defaultExcludePrereleases', 'INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing('projects', 'inheritReleaseFiltering', 'INTEGER NOT NULL DEFAULT 0');
};
