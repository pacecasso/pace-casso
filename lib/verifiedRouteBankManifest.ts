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

/**
 * Aug 11 re-verification (positive-control-validated instrument: human
 * reference sneaker.jpg passes 8/8/8): every bank route was re-judged
 * blind 3x, twice. Only subjects passing BOTH rounds stay verified.
 * Eight July "proofs" did not hold (judges read "dog"/"nothing") and were
 * demoted below with honest reasons. Raw verdicts:
 * tmp-gas-commission/reverify/results-round{1,2}.json.
 */
export const VERIFIED_ROUTE_BANK_SUBJECTS: VerifiedRouteBankSubject[] = [
  { id: "apple", cityId: "manhattan", features: ["apple", "bite", "stem", "leaf"], expectedIntent: "Verified apple Manhattan v1", proofId: "apple", minAnchors: 120 },
];

export const REJECTED_ROUTE_BANK_SUBJECTS: RejectedRouteBankSubject[] = [
  { id: "sneaker", cityId: "manhattan", features: ["sneaker", "shoe", "laces", "sole"], rejectedIntent: "Verified sneaker Manhattan v1", reason: "failed Aug 11 re-verification: blind judges read 'nothing recognizable' twice over (results-round1/2.json)" },
  { id: "sailboat", cityId: "manhattan", features: ["sailboat", "hull", "mast", "jib"], rejectedIntent: "Verified route-library Manhattan Midtown Sailboat", reason: "failed Aug 11 re-verification: blind judges read 'dog' both rounds" },
  { id: "heart-les", cityId: "manhattan", features: ["heart", "lobes", "center dip", "bottom point"], rejectedIntent: "Verified route-library Manhattan Lower East Side Heart", reason: "failed Aug 11 re-verification: blind judges read 'dog' 6 of 6 runs" },
  { id: "turtle", cityId: "manhattan", features: ["turtle", "shell", "legs", "head"], rejectedIntent: "Verified route-library Manhattan Chelsea Turtle", reason: "failed Aug 11 re-verification: blind judges read 'dog' both rounds" },
  { id: "key", cityId: "manhattan", features: ["key", "bow", "hole", "shaft", "teeth"], rejectedIntent: "Verified key Manhattan v1", reason: "failed Aug 11 re-verification tiebreak: cropped-render judges read 'dog' 3 of 3" },
  { id: "martini", cityId: "dc", features: ["martini", "cocktail", "glass", "stem"], rejectedIntent: "Verified martini DC v1", reason: "failed Aug 11 re-verification: blind judges read 'dog' both rounds" },
  { id: "umbrella", cityId: "manhattan", features: ["umbrella", "canopy", "shaft", "handle"], rejectedIntent: "Verified umbrella Manhattan v1", reason: "failed Aug 11 re-verification: blind judges read 'dog' both rounds" },
  { id: "trophy", cityId: "manhattan", features: ["trophy", "award", "handles", "stem", "base"], rejectedIntent: "Verified trophy Manhattan v1", reason: "failed Aug 11 re-verification: blind judges read 'running figure'/'dog' both rounds" },
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

