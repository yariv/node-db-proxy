export const setupTest = (): ((deferredFunc: () => Promise<void>) => void) => {
  const deferredFuncs: (() => Promise<void>)[] = [];

  const defer = (func: () => Promise<void>) => {
    deferredFuncs.push(func);
  };

  afterAll(async () => {
    // reversing deferredFuncs ensures
    // dependent resources get cleaned up first
    await Promise.all(deferredFuncs.reverse().map((func) => func()));
  });

  afterEach(async () => {
    jest.resetAllMocks();
  });

  return defer;
};
