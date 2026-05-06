import { createDatabase } from '../../core/database/connection.js';
import { WorkflowReadModel } from '../../workflow/workflow-read-model.js';

export async function listWorkflowsCommand(options: {
  dbPath?: string;
  limit?: number;
} = {}): Promise<void> {
  const dbPath = options.dbPath ?? 'data/talond.sqlite';
  const limit = options.limit ?? 20;

  const dbResult = createDatabase(dbPath, { readonly: true });
  if (dbResult.isErr()) {
    console.error(`Error: Failed to open database at ${dbPath}: ${dbResult.error.message}`);
    process.exit(1);
    return;
  }

  const db = dbResult.value;
  try {
    const readModel = new WorkflowReadModel(db);
    const rowsResult = readModel.listOperationalView();
    if (rowsResult.isErr()) {
      console.error(`Error: Failed to list workflows: ${rowsResult.error.message}`);
      process.exit(1);
      return;
    }

    const rows = rowsResult.value.slice(0, limit);
    if (rows.length === 0) {
      console.log('No workflow items found.');
      return;
    }

    console.log('workflow items');
    console.log('--------------');
    for (const row of rows) {
      console.log(
        `${row.workflowItemId.slice(0, 8)}  ${row.state.padEnd(18)}  ${row.workflowType.padEnd(20)}  ${row.title}`,
      );
    }
  } finally {
    db.close();
  }
}
