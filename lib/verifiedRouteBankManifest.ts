export type VerifiedRouteBankCityId = "manhattan" | "dc";

export type VerifiedRouteBankSubject = {
  id: string;
  cityId: VerifiedRouteBankCityId;
  features: string[];
  expectedIntent: string;
  proofId: string;
  minAnchors: number;
};

export type RejectedRouteBankSubject = {
  id: string;
  cityId: VerifiedRouteBankCityId;
  features: string[];
  rejectedIntent: string;
  reason: string;
};

export const VERIFIED_ROUTE_BANK_SUBJECTS: VerifiedRouteBankSubject[] = [
  { id: "sneaker", cityId: "manhattan", features: ["sneaker", "shoe", "laces", "sole"], expectedIntent: "Verified sneaker Manhattan v1", proofId: "sneaker", minAnchors: 1000 },
  { id: "sailboat", cityId: "manhattan", features: ["sailboat", "hull", "mast", "jib"], expectedIntent: "Verified route-library Manhattan Midtown Sailboat", proofId: "sailboat", minAnchors: 250 },
  { id: "heart", cityId: "manhattan", features: ["heart", "lobes", "center dip", "bottom point"], expectedIntent: "Verified route-library Manhattan Lower East Side Heart", proofId: "heart", minAnchors: 200 },
  { id: "turtle", cityId: "manhattan", features: ["turtle", "shell", "legs", "head"], expectedIntent: "Verified route-library Manhattan Chelsea Turtle", proofId: "turtle", minAnchors: 180 },
  { id: "apple", cityId: "manhattan", features: ["apple", "bite", "stem", "leaf"], expectedIntent: "Verified apple Manhattan v1", proofId: "apple", minAnchors: 120 },
  { id: "key", cityId: "manhattan", features: ["key", "bow", "hole", "shaft", "teeth"], expectedIntent: "Verified key Manhattan v1", proofId: "key", minAnchors: 90 },
  { id: "martini", cityId: "dc", features: ["martini", "cocktail", "glass", "stem"], expectedIntent: "Verified martini DC v1", proofId: "martini-dc", minAnchors: 150 },
  { id: "umbrella", cityId: "manhattan", features: ["umbrella", "canopy", "shaft", "handle"], expectedIntent: "Verified umbrella Manhattan v1", proofId: "umbrella", minAnchors: 90 },
  { id: "trophy", cityId: "manhattan", features: ["trophy", "award", "handles", "stem", "base"], expectedIntent: "Verified trophy Manhattan v1", proofId: "trophy", minAnchors: 70 },
];

export const REJECTED_ROUTE_BANK_SUBJECTS: RejectedRouteBankSubject[] = [
  { id: "robot", cityId: "manhattan", features: ["robot", "head", "antenna", "eyes"], rejectedIntent: "Verified robot Manhattan v2", reason: "label-free proof was too muddy to read as a robot" },
  { id: "crown", cityId: "manhattan", features: ["crown", "points", "jewel"], rejectedIntent: "Verified crown Manhattan v1", reason: "label-free proof was borderline and not strong enough for promotion" },
  { id: "tiger", cityId: "manhattan", features: ["tiger", "face", "stripes"], rejectedIntent: "Verified tiger Manhattan v1", reason: "long route was interesting but not clean in isolated blind view" },
  { id: "duck", cityId: "manhattan", features: ["duck", "bird", "beak"], rejectedIntent: "Verified route-library Manhattan LES Duckling", reason: "earlier visual bank presentation did not meet the recognizability bar" },
  { id: "tulip", cityId: "manhattan", features: ["tulip", "flower", "petals"], rejectedIntent: "Verified route-library Manhattan East Village Tulip", reason: "not in the strict proof bank" },
  { id: "glasses", cityId: "manhattan", features: ["eyeglasses", "glasses", "lenses"], rejectedIntent: "Verified glasses Manhattan v1", reason: "best route stayed experimental after label-free proof review" },
  { id: "envelope", cityId: "manhattan", features: ["envelope", "mail", "fold"], rejectedIntent: "Verified envelope Manhattan v1", reason: "variants read as generic rectangles without a label" },
  { id: "martini-manhattan", cityId: "manhattan", features: ["martini", "cocktail", "glass"], rejectedIntent: "Verified martini Manhattan v1", reason: "label-free north-up proof read as a tilted generic block, not a defensible martini glass" },
  { id: "fish", cityId: "manhattan", features: ["fish", "tail", "fin", "body"], rejectedIntent: "Verified fish Manhattan v1", reason: "best routed candidate was runnable but read as a long tail plus blocky cluster without the label" },
  { id: "coffee", cityId: "manhattan", features: ["coffee", "cup", "mug", "handle", "steam"], rejectedIntent: "Verified coffee Manhattan v1", reason: "routed variants had occasional mug cues but too often read as generic blocky machinery" },
  { id: "music", cityId: "manhattan", features: ["music", "note", "stem", "flag"], rejectedIntent: "Verified music Manhattan v1", reason: "music-note variants did not preserve a readable note silhouette in label-free review" },
  { id: "map-pin", cityId: "manhattan", features: ["map pin", "pin", "marker", "pointer"], rejectedIntent: "Verified map pin Manhattan v1", reason: "map-pin variants were runnable but read as abstract block shapes rather than a clear marker" },
];

