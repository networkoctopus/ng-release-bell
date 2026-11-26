'use strict';

exports.up = function(db) {
    const columns = db.prepare('PRAGMA table_info(projects)').all();
    if (!columns.some(column => column.name === 'latestVersionOnly')) {
        db.exec('ALTER TABLE projects ADD COLUMN latestVersionOnly INTEGER NOT NULL DEFAULT 0');
    }
};

exports.down = function(db) {
    db.exec('ALTER TABLE projects DROP COLUMN latestVersionOnly');
};