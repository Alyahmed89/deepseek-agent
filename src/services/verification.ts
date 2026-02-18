// Verification service for deterministic completion signals
// This provides external truth verification independent of AI judgment

export interface VerificationResult {
  success: boolean;
  reason: string;
  details?: any;
}

/**
 * Verify task completion based on external truth
 * This is a placeholder that should be extended with actual verification logic
 * 
 * Current placeholder checks:
 * 1. If repository contains test files, mark as "verifiable"
 * 2. If no test files, mark as "unverifiable" (requires manual verification)
 * 
 * In a real implementation, this would:
 * - Run test suites
 * - Check build status
 * - Verify deployment
 * - Validate observable outcomes
 * 
 * @param repository Repository identifier (owner/repo)
 * @param branch Git branch
 * @param iteration Current iteration number
 * @returns Verification result
 */
export async function verifyTaskCompletion(
  repository: string,
  branch: string = 'main',
  iteration: number
): Promise<VerificationResult> {
  console.log(`[VERIFICATION] Checking repository: ${repository}, branch: ${branch}, iteration: ${iteration}`);
  
  // Placeholder implementation
  // In a real system, this would:
  // 1. Clone the repository
  // 2. Check for test files (package.json, test/, spec/, etc.)
  // 3. Run tests if available
  // 4. Check build status
  // 5. Verify deployment
  
  // For now, we'll simulate different verification scenarios based on iteration
  // REMOVED: Hardcoded 3-iteration rule that was overriding user's max_iterations setting
  // The user explicitly sets max_iterations, and we should respect that
  
  // Default: task not yet verifiable via external verification
  // External verification should only trigger for actual completion signals, not arbitrary iteration counts
  return {
    success: false,
    reason: 'External verification not implemented - relying on AI completion signals',
    details: {
      current_iteration: iteration,
      verification_type: 'not_implemented',
      note: 'User max_iterations setting will be respected instead of hardcoded limits'
    }
  };
}

/**
 * Check if a task should be marked as complete based on external verification
 * This runs independently of AI judgment
 * 
 * @param repository Repository identifier
 * @param branch Git branch
 * @param iteration Current iteration
 * @param deepseekResponse DeepSeek's response (for reference only)
 * @returns Whether task should be marked as complete
 */
export async function shouldCompleteTask(
  repository: string,
  branch: string = 'main',
  iteration: number,
  deepseekResponse: string
): Promise<{
  shouldComplete: boolean;
  verificationResult: VerificationResult;
  completionReason: string;
}> {
  const verification = await verifyTaskCompletion(repository, branch, iteration);
  
  // Decision logic based on verification result
  if (verification.success) {
    return {
      shouldComplete: true,
      verificationResult: verification,
      completionReason: `External verification passed: ${verification.reason}`
    };
  }
  
  // Even if verification fails, we might complete based on other criteria
  // Only check for the explicit [END_FLOW] token, not generic "done" or "complete" words
  // that could appear in normal conversation
  const hasDeepSeekDoneSignal = deepseekResponse.includes('[END_FLOW]');
  
  // Only complete if we have the explicit stop token
  // Remove the iteration >= 5 requirement since user sets their own max_iterations
  if (hasDeepSeekDoneSignal) {
    return {
      shouldComplete: true,
      verificationResult: verification,
      completionReason: 'AI sent explicit [END_FLOW] token'
    };
  }
  
  return {
    shouldComplete: false,
    verificationResult: verification,
    completionReason: 'Insufficient verification criteria met'
  };
}