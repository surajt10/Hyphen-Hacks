import {
  Accessibility,
  Banknote,
  BedDouble,
  Bike,
  Car,
  Coffee,
  Footprints,
  Fuel,
  Hospital,
  Motorbike,
  Pill,
  Scooter,
  Shield,
  ShoppingCart,
  SquareParking,
  TrainFront,
  Utensils,
  Wine,
  type LucideIcon,
} from "lucide-react";
import type { Mode } from "@/lib/scoring";

export const MODE_ICON: Record<Mode, LucideIcon> = {
  walk: Footprints,
  wheelchair: Accessibility,
  bike: Bike,
  scooter: Scooter,
  moped: Motorbike,
  car: Car,
};

// Place categories, in the order of the tab bar next to the search box.
export const CAT_UI: { id: string; label: string; icon: LucideIcon; color: string }[] = [
  { id: "restaurant", label: "Restaurants", icon: Utensils, color: "#e8710a" },
  { id: "cafe", label: "Cafes", icon: Coffee, color: "#e8710a" },
  { id: "grocery", label: "Groceries", icon: ShoppingCart, color: "#1a73e8" },
  { id: "pharmacy", label: "Pharmacies", icon: Pill, color: "#e52592" },
  { id: "transit", label: "Transit", icon: TrainFront, color: "#1a73e8" },
  { id: "hospital", label: "Hospitals", icon: Hospital, color: "#d93025" },
  { id: "atm", label: "ATMs", icon: Banknote, color: "#5f6368" },
  { id: "hotel", label: "Hotels", icon: BedDouble, color: "#c2185b" },
  { id: "bar", label: "Bars", icon: Wine, color: "#e8710a" },
  { id: "gas", label: "Gas", icon: Fuel, color: "#1a73e8" },
  { id: "parking", label: "Parking", icon: SquareParking, color: "#1a73e8" },
  { id: "police", label: "Police", icon: Shield, color: "#5f6368" },
];
export const CAT = Object.fromEntries(CAT_UI.map((c) => [c.id, c]));
