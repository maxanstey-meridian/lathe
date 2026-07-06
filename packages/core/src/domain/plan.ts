export type Plan = {
  planId: string;
  title: string;
  raw: string;
  tags: string[];
  queuedRunId?: string;
  createdAt: string;
  updatedAt: string;
};
