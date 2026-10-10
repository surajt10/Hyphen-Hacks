// Google-style place icons for the map: a coloured circle with a white lucide glyph,
// rendered to images the map can use as symbols.
import type { Map as MLMap } from "maplibre-gl";
import { __iconData as utensils } from "lucide-react/dist/esm/icons/utensils.mjs";
import { __iconData as coffee } from "lucide-react/dist/esm/icons/coffee.mjs";
import { __iconData as wine } from "lucide-react/dist/esm/icons/wine.mjs";
import { __iconData as cart } from "lucide-react/dist/esm/icons/shopping-cart.mjs";
import { __iconData as pill } from "lucide-react/dist/esm/icons/pill.mjs";
import { __iconData as bed } from "lucide-react/dist/esm/icons/bed-double.mjs";
import { __iconData as landmark } from "lucide-react/dist/esm/icons/landmark.mjs";
import { __iconData as ticket } from "lucide-react/dist/esm/icons/ticket.mjs";
import { __iconData as train } from "lucide-react/dist/esm/icons/train-front.mjs";
import { __iconData as hospital } from "lucide-react/dist/esm/icons/hospital.mjs";
import { __iconData as trees } from "lucide-react/dist/esm/icons/trees.mjs";
import { __iconData as bag } from "lucide-react/dist/esm/icons/shopping-bag.mjs";

type Node = [string, Record<string, string | number>][];

// Base-map places: OpenStreetMap tags fetched near the map center, and how each one looks.
export const MAP_POI: Record<string, { tags: string[]; color: string; node: Node; label: string }> = {
  restaurant: { tags: ["amenity:restaurant", "amenity:fast_food"], color: "#e8710a", node: utensils.node, label: "Restaurant" },
  cafe: { tags: ["amenity:cafe"], color: "#e8710a", node: coffee.node, label: "Cafe" },
  bar: { tags: ["amenity:bar", "amenity:pub"], color: "#e8710a", node: wine.node, label: "Bar" },
  grocery: { tags: ["shop:supermarket"], color: "#1a73e8", node: cart.node, label: "Grocery" },
  shopping: { tags: ["shop:mall", "shop:department_store"], color: "#1a73e8", node: bag.node, label: "Shopping" },
  pharmacy: { tags: ["amenity:pharmacy"], color: "#e52592", node: pill.node, label: "Pharmacy" },
  hotel: { tags: ["tourism:hotel"], color: "#c2185b", node: bed.node, label: "Hotel" },
  museum: { tags: ["tourism:museum", "tourism:gallery"], color: "#9334e6", node: landmark.node, label: "Museum" },
  attraction: { tags: ["tourism:attraction", "amenity:theatre", "amenity:cinema"], color: "#9334e6", node: ticket.node, label: "Things to do" },
  transit: { tags: ["railway:station", "public_transport:station"], color: "#5f6368", node: train.node, label: "Transit" },
  hospital: { tags: ["amenity:hospital"], color: "#d93025", node: hospital.node, label: "Hospital" },
  park: { tags: ["leisure:park"], color: "#188038", node: trees.node, label: "Park" },
};

export const POI_OF_TAG: Record<string, string> = Object.fromEntries(Object.entries(MAP_POI).flatMap(([cat, v]) => v.tags.map((t) => [t, cat])));

function svgFor(node: Node, color: string) {
  const inner = node
    .map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).filter(([k]) => k !== "key").map(([k, v]) => `${k}="${v}"`).join(" ")}/>`)
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><circle cx="32" cy="32" r="27" fill="${color}" stroke="#ffffff" stroke-width="4"/><g transform="translate(18 18) scale(1.1667)" fill="none" stroke="#ffffff" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">${inner}</g></svg>`;
}

// Register every icon on the map (again after a style change). Images load async.
export async function addPoiIcons(map: MLMap) {
  await Promise.all(
    Object.entries(MAP_POI).map(async ([cat, v]) => {
      const id = `poi-${cat}`;
      if (map.hasImage(id)) return;
      const img = new Image(64, 64);
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgFor(v.node, v.color))}`;
      try {
        await img.decode();
        if (!map.hasImage(id)) map.addImage(id, img, { pixelRatio: 2 });
      } catch {}
    }),
  );
}
