/**
 * AWS (Aily Wiring Syntax) Module Exports
 * @module connection-aws
 */

// Types
export * from './aws-types';

// Parser
export { parseAWS, hasErrors, formatErrors, formatWarnings } from './aws-parser';

// Generator
export { generateAWS, generatePinmapSummary, generateMultiplePinmapSummaries } from './aws-generator';

// Pin Resolver
export { resolvePin, resolveAllPins, detectPinConflicts } from './pin-resolver';

// AWS to JSON Converter
export { convertAWSToJSON, AWSConverter } from './aws-converter';
