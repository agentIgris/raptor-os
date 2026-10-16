import * as migration_20261013_122306 from './20261013_122306.js';
import * as migration_20261013_124029 from './20261013_124029.js';

export const migrations = [
  {
    up: migration_20261013_122306.up,
    down: migration_20261013_122306.down,
    name: '20261013_122306',
  },
  {
    up: migration_20261013_124029.up,
    down: migration_20261013_124029.down,
    name: '20261013_124029'
  },
];
