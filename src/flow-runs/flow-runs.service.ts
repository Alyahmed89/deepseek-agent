import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { runFlow } from '../execution/engine';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

@Injectable()
export class FlowRunsService {
  async resume(id: string, userInput?: Record<string, any>) {
    if (userInput) {
      for (const [key, value] of Object.entries(userInput)) {
        // Write as jas_var with version bump
        const varId = `var_${key}`;
        const { count } = await supabase
          .from('knowledge')
          .select('*', { count: 'exact', head: true })
          .like('prolog', `jas_var('${varId}',%,'${id}','${key}',%`);
        const nextVer = (count || 0) + 1;
        const safeVal = String(value).replace(/'/g, "\\'");
        await supabase.from('knowledge').insert({
          id: randomUUID(),
          prolog: `jas_var('${varId}', ${nextVer}, '${id}', '${key}', '${safeVal}').`,
          namespace: 'jas', level: 'L2'
        });
        // Keep old input/3 for backward compat during transition
        const factId = `input_${id}_${key}`;
        const prolog = `input('${id}', '${key}', '${safeVal}').`;
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
