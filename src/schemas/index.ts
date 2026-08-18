/**
 * Every schema and inferred type in one place.
 *
 * Import from here rather than from individual files so that reorganising the
 * schema modules does not break consumers.
 */

export * from './common.js';
export * from './profile.js';
export * from './note.js';
export * from './publication.js';
export * from './post.js';
export * from './discovery.js';
