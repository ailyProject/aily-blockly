import { _BuilderService } from './builder.service';
import { ProcessState } from '@core/app-shell/public-api';

describe('active private compiler ownership', () => {
  it('a rejected second build cannot discard the first build cancellation or input identity', async () => {
    const service: any = Object.create(_BuilderService.prototype);
    const execution = { execution: { id: 'original-execution', buildRequestId: 'original-request' } };
    service.activeExecutionConfig = execution;
    service.isCloudBuild = () => false;
    service.projectService = { currentPackageData: {} };
    service.workflowService = { startBuild: () => false, currentState: ProcessState.BUILDING };
    service.t = (key: string) => key;
    service.message = { warning: jasmine.createSpy('warning') };
    await expectAsync(service.build(undefined, 'rejected-second-request')).toBeRejected();
    expect(service.activeExecutionConfig).toBe(execution);
  });
});
