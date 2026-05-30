import { Injectable } from '@nestjs/common';
import { runFlow } from '../execution/engine';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

@Injectable()
export class FlowRunsService {
  async resume(id: string, userInput?: Record<string, any>) {
    if (userInput) {
      for (const [key, value] of Object.entries(userInput)) {
        const factId = `input_${id}_${key}`;
        const prolog = `input('${id}', '${key}', '${value}').`;
        await supabase.from('knowledge').upsert({ id: factId, prolog });
      }
    }
    await runFlow(id);
    return { status: 'resumed' };
  }

  async runStep(id: string) {
    await runFlow(id);
    return { status: 'run' };
  }
}
