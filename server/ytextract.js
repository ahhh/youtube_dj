// The YouTube extractor lives in tools/tubedj-convert.mjs so the downloadable CLI
// and the server share one copy. Re-exported here for the server and its tests.
export { VIDEO_ID, pickAudio, resolveAudio, streamAudio } from '../tools/tubedj-convert.mjs';
