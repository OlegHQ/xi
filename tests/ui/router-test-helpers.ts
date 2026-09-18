/** H1-7: `OpenTuiWorkbenchOptions.dispatchKey` is required now that `packages/ui` no longer
 * holds its own copy of the overlay-focus-stack/fallthrough dispatch policy
 * (`WorkbenchInputRouter.dispatchKey` owns it). Tests that only care about a single
 * "handle every key like the old `onKeypress` fallthrough did" behavior can wrap that
 * function with this instead of standing up a real router. */
export function dispatchKeyFromOnKeypress(
  onKeypress: (event: unknown) => boolean | 'quit' | Promise<boolean | 'quit'>,
): (event: unknown) => 'consumed' | 'pending' | 'unhandled' | 'quit' | Promise<'consumed' | 'pending' | 'unhandled' | 'quit'> {
  return (event) => {
    const result = onKeypress(event);
    const finish = (value: boolean | 'quit'): 'consumed' | 'unhandled' | 'quit' => value === 'quit' ? 'quit' : value ? 'consumed' : 'unhandled';
    return result instanceof Promise ? result.then(finish) : finish(result);
  };
}
