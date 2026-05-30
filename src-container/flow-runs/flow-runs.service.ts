import { Injectable } from '@nestjs/common';
import { runFlow, getExecution, storeMemory } from '../execution/engine';
import { getSupabase } from '../supabase';

@Injectable()
export class FlowRunsService {
  async resume(id: string, userInput?: Record<string, any>) {
    // store user input as memory before resuming
    // flatten nested user_input like {user_input: {input_user_prompt: "text"}} → {input_user_prompt: "text"}
    if (userInput && typeof userInput === 'object') {
      const flat: Record<string, any> = {};
      for (const [key, value] of Object.entries(userInput)) {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          for (const [k, v] of Object.entries(value)) {
            flat[k] = v;
          }
        } else {
          flat[key] = value;
        }
      }
      for (const [key, value] of Object.entries(flat)) {
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
