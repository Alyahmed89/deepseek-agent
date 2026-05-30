import { Injectable } from '@nestjs/common';
import { runFlow } from '../execution/engine';

@Injectable()
export class FlowRunsService {
  async resume(id: string, userInput?: Record<string, any>) {
    await runFlow(id, userInput);
    return { status: 'resumed' };
  }

  async runStep(id: string) {
    await runFlow(id);
    return { status: 'run' };
  }
}
