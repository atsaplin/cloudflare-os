// Vite+ per-package settings. The `test` task definition is shared by every package whose tests run
// under vitest and lives beside the other shared task configs.
import { vitestTask } from '../../scripts/vitest-task-vite-config.js'

export default {
  run: {
    tasks: {
      test: {
        ...vitestTask('vitest run'),
        dependsOn: ['@gadgets/workshop-backend#build:integration-worker'],
      },
    },
  },
}
