'use strict';

exports.up = function(db) {
    db.exec('ALTER TABLE projects ADD COLUMN latestVersionOnly INTEGER NOT NULL DEFAULT 0');
};

exports.down = function(db) {
    db.exec('ALTER TABLE projects DROP COLUMN latestVersionOnly');
};