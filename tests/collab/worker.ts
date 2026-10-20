import { claimResources } from '../../src/collab/resources.js';
import { transact } from '../../src/collab/store.js';
import { reserveLaunch } from '../../src/collab/admission.js';

const [action, taskRoot, target, id] = process.argv.slice(2);
if (!taskRoot) throw new Error('A fixture task root is required.');
if (action === 'claim' && target && id) {
  console.log(
    JSON.stringify(
      claimResources(taskRoot, {
        resources: [{ path: target }],
        holder: {
          agent_id: id,
          session_id: `session-${id}`,
          harness: 'fixture',
        },
      }),
    ),
  );
} else if (action === 'reserve' && id) {
  console.log(
    JSON.stringify(
      reserveLaunch(taskRoot, {
        reservation: {
          reservation_id: id,
          subtask_id: 'work',
          attempt: 1,
          kind: 'first',
          mode: 'work',
          holder: { agent_id: id, session_id: id, harness: 'fixture' },
          requested_session_id: id,
        },
      }),
    ),
  );
} else if (action === 'fault') {
  transact(taskRoot, {
    apply: (record) => {
      record.input_revision = 'must-not-commit';
      return { record };
    },
  });
} else throw new Error('Invalid fixture action.');
