// Fact validation utilities for authoritative project facts
import { ProjectFact } from '../types';

/**
 * Check if a string contains a fact placeholder
 * Format: $FACT.<TAG>
 */
export function containsFactPlaceholder(text: string): boolean {
  return /\$FACT\.\w+/.test(text);
}

/**
 * Extract all fact placeholders from a string
 * @returns Array of tag names (without $FACT. prefix)
 */
export function extractFactPlaceholders(text: string): string[] {
  const matches = text.match(/\$FACT\.(\w+)/g) || [];
  return matches.map(match => match.substring(6)); // Remove "$FACT."
}

/**
 * Validate that DeepSeek response uses only allowed fact placeholders
 * and doesn't use literals where facts should be used
 * 
 * @param text DeepSeek response text
 * @param projectFacts Available project facts
 * @returns Validation result with error message if invalid
 */
export function validateFactUsage(
  text: string,
  projectFacts: ProjectFact[]
): { valid: boolean; error?: string; violations?: string[] } {
  const violations: string[] = [];
  
  // Extract all fact placeholders used
  const usedPlaceholders = extractFactPlaceholders(text);
  
  // Check for unknown placeholders
  const knownTags = new Set(projectFacts.map(fact => fact.tag));
  const unknownPlaceholders = usedPlaceholders.filter(tag => !knownTags.has(tag));
  
  if (unknownPlaceholders.length > 0) {
    violations.push(`Unknown fact tags: ${unknownPlaceholders.join(', ')}`);
  }
  
  // Check for common patterns that should use facts but might use literals
  // This is a heuristic - in practice, you'd have a more sophisticated check
  const suspiciousPatterns = [
    // URLs
    /https?:\/\/[^\s]+/g,
    // File paths (Unix)
    /\/[\w\-\.\/]+/g,
    // File paths (Windows)
    /[A-Za-z]:\\[^\s]+/g,
    // Common commands
    /\b(git|npm|yarn|pip|docker|kubectl|aws)\s+[^\s]/g,
    // Repository references
    /github\.com\/[^\s]+/g,
    /gitlab\.com\/[^\s]+/g,
  ];
  
  for (const pattern of suspiciousPatterns) {
    const matches = text.match(pattern) || [];
    for (const match of matches) {
      // Check if this looks like it should be a fact but isn't
      if (!containsFactPlaceholder(match)) {
        // This is a heuristic - in practice you'd have a whitelist or more sophisticated logic
        violations.push(`Potential literal where fact should be used: "${match.substring(0, 50)}${match.length > 50 ? '...' : ''}"`);
      }
    }
  }
  
  if (violations.length > 0) {
    return {
      valid: false,
      error: `Fact validation failed: ${violations.join('; ')}`,
      violations
    };
  }
  
  return { valid: true };
}

/**
 * Resolve fact placeholders in text
 * @param text Text containing $FACT.<TAG> placeholders
 * @param projectFacts Available project facts
 * @returns Resolved text with placeholders replaced
 */
export function resolveFactPlaceholders(
  text: string,
  projectFacts: ProjectFact[]
): { resolvedText: string; unresolvedTags: string[] } {
  const unresolvedTags: string[] = [];
  let resolvedText = text;
  
  // Create a map of tag -> value
  const factMap = new Map<string, string>();
  for (const fact of projectFacts) {
    factMap.set(fact.tag, fact.value);
  }
  
  // Replace all $FACT.<TAG> occurrences
  const placeholderRegex = /\$FACT\.(\w+)/g;
  resolvedText = resolvedText.replace(placeholderRegex, (match, tag) => {
    const value = factMap.get(tag);
    if (value) {
      return value;
    } else {
      unresolvedTags.push(tag);
      return match; // Keep placeholder if not found
    }
  });
  
  return { resolvedText, unresolvedTags };
}