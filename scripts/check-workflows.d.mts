// Types for check-workflows.mjs, for tests/workflowPolicy.test.ts.
export declare function triggers(text: string): string[]
export declare function jobs(text: string): { id: string; text: string }[]
export declare function jobName(job: { id: string; text: string }): string
export declare function actionRefs(text: string): { ref: string; comment: string }[]
export declare function workflowProblems(files: Record<string, string>, maintenance: string): string[]
export declare function readWorkflows(root: string): Record<string, string>
