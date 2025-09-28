/**
 * The main function group which determines the flow of remote browser management.
 * Holds the singleton instances of browser pool and socket.io server.
 */
import { Socket } from "socket.io";
import { v4 as uuid } from "uuid";

import { createSocketConnection, createSocketConnectionForRun } from "../socket-connection/connection";
import { io, browserPool } from "../server";
import { RemoteBrowser } from "./classes/RemoteBrowser";
import { RemoteBrowserOptions } from "../types";
import logger from "../logger";

/**
 * Starts and initializes a {@link RemoteBrowser} instance.
 * Creates a new socket connection over a dedicated namespace
 * and registers all interaction event handlers.
 * Returns the id of an active browser or the new remote browser's generated id.
 * @param options {@link RemoteBrowserOptions} to be used when launching the browser
 * @returns string
 * @category BrowserManagement-Controller
 */
export const initializeRemoteBrowserForRecording = (userId: string, mode: string = "dom"): string => {
  const id = getActiveBrowserIdByState(userId, "recording") || uuid();
  createSocketConnection(
    io.of(id),
    userId,
    async (socket: Socket) => {
      // browser is already active
      const activeId = getActiveBrowserIdByState(userId, "recording");
      if (activeId) {
        const remoteBrowser = browserPool.getRemoteBrowser(activeId);
        remoteBrowser?.updateSocket(socket);
        await remoteBrowser?.makeAndEmitScreenshot();
      } else {
        const browserSession = new RemoteBrowser(socket, userId, id);
        browserSession.interpreter.subscribeToPausing();
        await browserSession.initialize(userId);
        await browserSession.registerEditorEvents();

        if (mode === "dom") {
          await browserSession.subscribeToDOM();
          logger.info('DOM streaming started for scraping browser in recording mode');
        } else {
          await browserSession.subscribeToScreencast();
          logger.info('Screenshot streaming started for local browser in recording mode');
        }
        
        browserPool.addRemoteBrowser(id, browserSession, userId, false, "recording");
      }
      socket.emit('loaded');
    });
  return id;
};

/**
 * Starts and initializes a {@link RemoteBrowser} instance for interpretation.
 * Creates a new {@link Socket} connection over a dedicated namespace.
 * Returns the new remote browser's generated id.
 * @param userId User ID for browser ownership
 * @returns string Browser ID
 * @category BrowserManagement-Controller
 */
export const createRemoteBrowserForRun = (userId: string): string => {
  if (!userId) {
    logger.log('error', 'createRemoteBrowserForRun: Missing required parameter userId');
    throw new Error('userId is required');
  }
  
  const id = uuid();

  const slotReserved = browserPool.reserveBrowserSlot(id, userId, "run");
  if (!slotReserved) {
    logger.log('warn', `Cannot create browser for user ${userId}: no available slots`);
    throw new Error('User has reached maximum browser limit');
  }

  logger.log('info', `createRemoteBrowserForRun: Reserved slot ${id} for user ${userId}`);

  initializeBrowserAsync(id, userId)
    .catch((error: any) => {
      logger.log('error', `Unhandled error in initializeBrowserAsync for browser ${id}: ${error.message}`);
      browserPool.failBrowserSlot(id);
    });
  
  return id;
};

/**
 * Terminates a remote browser recording session
 * and removes the browser from the browser pool.
 * @param id instance id of the remote browser to be terminated
 * @returns {Promise<boolean>}
 * @category BrowserManagement-Controller
 */
export const destroyRemoteBrowser = async (id: string, userId: string): Promise<boolean> => {
  try {
    const browserSession = browserPool.getRemoteBrowser(id);
    if (!browserSession) {
      logger.log('info', `Browser with id: ${id} not found, may have already been destroyed`);
      return true; 
    }
    
    logger.log('debug', `Switching off the browser with id: ${id}`);
    
    try {
      await browserSession.stopCurrentInterpretation();
    } catch (stopError) {
      logger.log('warn', `Error stopping interpretation for browser ${id}: ${stopError}`);
    }
    
    try {
      await browserSession.switchOff();
    } catch (switchOffError) {
      logger.log('warn', `Error switching off browser ${id}: ${switchOffError}`);
    }

    try {
      const namespace = io.of(id);
      namespace.removeAllListeners();
      namespace.disconnectSockets(true);
      logger.log('debug', `Cleaned up socket namespace for browser ${id}`);
    } catch (namespaceCleanupError: any) {
      logger.log('warn', `Error cleaning up socket namespace for browser ${id}: ${namespaceCleanupError.message}`);
    }

    return browserPool.deleteRemoteBrowser(id);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.log('error', `Failed to destroy browser ${id}: ${errorMessage}`);
    
    try {
      return browserPool.deleteRemoteBrowser(id);
    } catch (deleteError) {
      logger.log('error', `Failed to delete browser ${id} from pool: ${deleteError}`);
      return false;
    }
  }
};

/**
 * Returns the id of an active browser or null.
 * Wrapper around {@link browserPool.getActiveBrowserId()} function.
 * @returns {string | null}
 * @category  BrowserManagement-Controller
 */
export const getActiveBrowserId = (userId: string): string | null => {
  return browserPool.getActiveBrowserId(userId);
};

/**
 * Returns the id of an active browser with the specified state or null.
 * @param userId the user ID to find the browser for
 * @param state the browser state to filter by ("recording" or "run")
 * @returns {string | null}
 * @category  BrowserManagement-Controller
 */
export const getActiveBrowserIdByState = (userId: string, state: "recording" | "run"): string | null => {
  return browserPool.getActiveBrowserId(userId, state);
};

/**
 * Checks if there are available browser slots for a user.
 * Wrapper around {@link browserPool.hasAvailableBrowserSlots()} function.
 * If state is provided, also checks that none of their active browsers are in that state.
 * @param userId the user ID to check browser slots for
 * @param state optional state to check - if provided, ensures no browser is in this state
 * @returns {boolean} true if user has available slots (and no browsers in specified state if state is provided)
 * @category BrowserManagement-Controller
 */
export const canCreateBrowserInState = (userId: string, state?: "recording" | "run"): boolean => {
  return browserPool.hasAvailableBrowserSlots(userId, state);
};

/**
 * Returns the url string from a remote browser if exists in the browser pool.
 * @param id instance id of the remote browser
 * @returns {string | undefined}
 * @category  BrowserManagement-Controller
 */
export const getRemoteBrowserCurrentUrl = (id: string, userId: string): string | undefined => {
  return browserPool.getRemoteBrowser(id)?.getCurrentPage()?.url();
};

/**
 * Returns the array of tab strings from a remote browser if exists in the browser pool.
 * @param id instance id of the remote browser
 * @return {string[] | undefined}
 * @category  BrowserManagement-Controller
 */
export const getRemoteBrowserCurrentTabs = (id: string, userId: string): string[] | undefined => {
  return browserPool.getRemoteBrowser(id)?.getCurrentPage()?.context().pages()
    .map((page) => {
      const parsedUrl = new URL(page.url());
      const host = parsedUrl.hostname.match(/\b(?!www\.)[a-zA-Z0-9]+/g)?.join('.');
      if (host) {
        return host;
      }
      return 'new tab';
    });
};

/**
 * Interprets the currently generated workflow in the active browser instance.
 * If there is no active browser, the function logs an error.
 * @returns {Promise<void>}
 * @category  BrowserManagement-Controller
 */
export const interpretWholeWorkflow = async (userId: string) => {
  const id = getActiveBrowserIdByState(userId, "recording");
  if (id) {
    const browser = browserPool.getRemoteBrowser(id);
    if (browser) {
      await browser.interpretCurrentRecording();
    } else {
      logger.log('error', `No active browser with id ${id} found in the browser pool`);
    }
  } else {
    logger.log('error', `Cannot interpret the workflow: bad id ${id}.`);
  }
};

/**
 * Stops the interpretation of the current workflow in the active browser instance.
 * If there is no active browser, the function logs an error.
 * @returns {Promise<void>}
 * @category  BrowserManagement-Controller
 */
export const stopRunningInterpretation = async (userId: string) => {
  const id = getActiveBrowserIdByState(userId, "recording");
  if (id) {
    const browser = browserPool.getRemoteBrowser(id);
    await browser?.stopCurrentInterpretation();
  } else {
    logger.log('error', 'Cannot stop interpretation: No active browser or generator.');
  }
};

const initializeBrowserAsync = async (id: string, userId: string) => {
  try {
    const namespace = io.of(id);
    let clientConnected = false;
    let connectionTimeout: NodeJS.Timeout;
    
    const waitForConnection = new Promise<Socket | null>((resolve) => {
      namespace.on('connection', (socket: Socket) => {
        clientConnected = true;
        clearTimeout(connectionTimeout);
        logger.log('info', `Frontend connected to browser ${id} via socket ${socket.id}`);
        resolve(socket);
      });
      
      connectionTimeout = setTimeout(() => {
        if (!clientConnected) {
          logger.log('warn', `No client connected to browser ${id} within timeout, proceeding with dummy socket`);
          resolve(null);
        }
      }, 15000);
    });

    namespace.on('error', (error: any) => {
      logger.log('error', `Socket namespace error for browser ${id}: ${error.message}`);
      clearTimeout(connectionTimeout);
      browserPool.failBrowserSlot(id);
    });

    const socket = await waitForConnection;
    
    try {
      let browserSession: RemoteBrowser;
      
      if (socket) {
        logger.log('info', `Using real socket for browser ${id}`);
        browserSession = new RemoteBrowser(socket, userId, id);
      } else {
        logger.log('info', `Using dummy socket for browser ${id}`);
        const dummySocket = {
          emit: (event: string, data?: any) => {
            logger.log('debug', `Browser ${id} dummy socket emitted ${event}:`, data);
          },
          on: () => {},
          id: `dummy-${id}`,
        } as any;
        
        browserSession = new RemoteBrowser(dummySocket, userId, id);
      }

      logger.log('debug', `Starting browser initialization for ${id}`);

      try {
        await browserSession.initialize(userId);
        logger.log('debug', `Browser initialization completed for ${id}`);
      } catch (initError: any) {
        try {
          await browserSession.switchOff();
          logger.log('info', `Cleaned up failed browser initialization for ${id}`);
        } catch (cleanupError: any) {
          logger.log('error', `Failed to cleanup browser ${id}: ${cleanupError.message}`);
        }
        throw initError;
      }

      const upgraded = browserPool.upgradeBrowserSlot(id, browserSession);
      if (!upgraded) {
        try {
          await browserSession.switchOff();
        } catch (cleanupError: any) {
          logger.log('error', `Failed to cleanup browser after slot upgrade failure: ${cleanupError.message}`);
        }
        throw new Error('Failed to upgrade reserved browser slot');
      }
      
      await new Promise(resolve => setTimeout(resolve, 500));
      
      if (socket) {
        socket.emit('ready-for-run');
      } else {
        setTimeout(async () => {
          try {
            logger.log('info', `Browser ${id} with dummy socket is ready for execution`);
          } catch (error: any) {
            logger.log('error', `Error with dummy socket browser ${id}: ${error.message}`);
          }
        }, 100); 
      }
      
      logger.log('info', `Browser ${id} successfully initialized for run with ${socket ? 'real' : 'dummy'} socket`);
      
    } catch (error: any) {
      logger.log('error', `Error initializing browser ${id}: ${error.message}`);
      browserPool.failBrowserSlot(id);
      if (socket) {
        socket.emit('error', { message: error.message });
      }
      throw error;
    }
    
  } catch (error: any) {
    logger.log('error', `Error setting up browser ${id}: ${error.message}`);
    browserPool.failBrowserSlot(id);
    throw error;
  }
};
