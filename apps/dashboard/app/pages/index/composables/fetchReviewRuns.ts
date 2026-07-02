import type { RivetClient } from "@lathe/contract";
import type { components } from "@lathe/contract";

import { client } from "@lathe/contract";

type ReviewRun = components["schemas"]["ReviewRunDto"];

export const fetchReviewRunsWithClient = async (c: RivetClient): Promise<ReviewRun[]> => {
  const result = await c.GET("/review");
  return result.data?.runs ?? [];
};

export const fetchReviewRuns = async (): Promise<ReviewRun[]> => {
  const result = await client.GET("/review");
  return result.data?.runs ?? [];
};
