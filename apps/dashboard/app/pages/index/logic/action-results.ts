export const removeReviewRunAfterSuccess = async (
  runId: string,
  action: (runId: string) => Promise<boolean>,
  removeRun: (runId: string) => void,
): Promise<boolean> => {
  const succeeded = await action(runId);
  if (succeeded) {
    removeRun(runId);
  }
  return succeeded;
};

export const clearAnswerAfterSuccess = async (
  runId: string,
  answer: string,
  action: (runId: string, answer: string) => Promise<boolean>,
  clearAnswer: (runId: string) => void,
): Promise<boolean> => {
  const succeeded = await action(runId, answer);
  if (succeeded) {
    clearAnswer(runId);
  }
  return succeeded;
};
