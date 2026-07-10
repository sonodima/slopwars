// Ambient declarations for the virtual modules provided by the asset-catalog
// Vite plugin. Both apps reference these so `tsc` can typecheck the imports.
declare module "virtual:asset-catalog" {
  import type { AssetCatalog } from "@slopwars/shared";
  const catalog: AssetCatalog;
  export default catalog;
}
declare module "virtual:map-catalog" {
  import type { MapCatalogEntry } from "@slopwars/shared";
  const maps: MapCatalogEntry[];
  export default maps;
}
