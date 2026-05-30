import { Injectable } from '@nestjs/common';
import { runFlow } from '../execution/engine';
import { getSupabase } from '../supabase';

@Injectable()
export class FlowRunsService {
  async resume(id: string, userInput?: Record<string, any>) {
    // store user input as memory before resuming
    if (userInput && typeof userInput === 'object') {
      for (const [key, value] of Object.entries(userInput)) {
        const strValue = typeof value === 'string' ? value : JSON.stringify(value);
        await getSupabase().from('memory').upsert(
          { execution_id: id, key, value: strValue, scope: 'flow' },
          { onConflict: 'execution_id,key' }
        );
      }
    }
    runFlow(id).catch(err => console.error('[resume] runFlow error:', err));
    return { status: 'resumed' };
  }
}
