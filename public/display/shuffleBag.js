// makeShuffleBag — the display's random-track draw source. Page RNG (Math.random),
// NOT sim state: the native series layer asks the host for a draw and this is the
// host's answer, so it deliberately stays in JS. Extracted from GrandPrix.js when
// the JS series was retired (the C++ CupSeries owns points and chaining now).

export function makeShuffleBag(ids, rng) {
  const all = [...ids];
  let bag = [];
  let last = null;
  const refill = () => {
    bag = [...all];
    for (let i = bag.length - 1; i > 0; i--) { // Fisher–Yates
      const j = Math.floor(rng() * (i + 1));
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
    // draw() pops from the END — swap a boundary repeat to the far end of the bag
    if (all.length > 1 && bag[bag.length - 1] === last) {
      [bag[0], bag[bag.length - 1]] = [bag[bag.length - 1], bag[0]];
    }
  };
  return {
    draw() {
      if (!bag.length) refill();
      last = bag.pop();
      return last;
    }
  };
}
