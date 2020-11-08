/**
 * Wait a given number of milliseconds, in Promise form.
 * @param msec Number of milliseconds to wait.
 * @returns A Promise which resolves void in the given number of milliseconds.
 */
const wait = (msec: number) => new Promise(r => setTimeout(r, msec));

type OrchestratorType = {
  signals: Record<string, any>;
  sendSignal: (sigName: string, data?: any) => void;
  waitOnSignal: (sigName: string) => Promise<any>;
  hasSignalPassed: (sigName: string) => boolean;
  clearSignal: (sigName: string) => void;
  clearAllSignals: () => void;
}
/** Provides an interface for the application to send signals containing reusable data across threads. */
const Orchestrator: OrchestratorType = {
  /** The signals that have been sent so far. */
  signals: {},

  /**
   * Sends a signal to other threads.
   * @function sendSignal
   * @param sigName The name of the signal.
   * @param data Optional. Any data to include with the signal.
   */
  sendSignal: (sigName: string, data?: any) => {
    if (!Object.keys(Orchestrator.signals).includes(sigName)) Orchestrator.signals[sigName] = data;
  },

  /**
   * Waits until a signal has been sent.
   * @async
   * @function waitOnSignal
   * @param sigName The name of the signal to wait for.
   * @returns A promise that resolves when the signal is sent, into any data included with that signal.
   */
  waitOnSignal: async (sigName: string): Promise<any> => {
    while (1) {
      if (Object.keys(Orchestrator.signals).includes(sigName)) return Orchestrator.signals[sigName];
      await wait(100);
    }
  },

  hasSignalPassed: (sigName: string) =>
    Object.keys(Orchestrator.signals).includes(sigName),

  clearSignal: (sigName: string) => { if (Object.keys(Orchestrator.signals).includes(sigName)) delete Orchestrator.signals[sigName]; },

  clearAllSignals: () => Orchestrator.signals = {}
};

export default Orchestrator;