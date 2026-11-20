// MapLibre draws tiles in a worker.  Built this way, the worker ships with the app and loads from
// its own address, so the content security policy needs no other host for workers.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

export const MAP_WORKER_URL: string = workerUrl;
