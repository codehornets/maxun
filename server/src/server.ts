import express from 'express';
import path from 'path';
import http from 'http';
import { Server } from "socket.io";
import cors from 'cors';
import dotenv from 'dotenv';
dotenv.config();
import { record, workflow, storage, auth, integration, proxy, webhook } from './routes';
import { BrowserPool } from "./browser-management/classes/BrowserPool";
import logger from './logger';
import { connectDB, syncDB } from './storage/db'
import cookieParser from 'cookie-parser';
import { SERVER_PORT } from "./constants/config";
import { readdirSync } from "fs"
import { fork } from 'child_process';
import { capture } from "./utils/analytics";
import swaggerUi from 'swagger-ui-express';
import swaggerSpec from './swagger/config';
import connectPgSimple from 'connect-pg-simple';
import pg from 'pg';
import session from 'express-session';
import Run from './models/Run';
import { processQueuedRuns, recoverOrphanedRuns } from './routes/storage';
import { startWorkers } from './pgboss-worker';

const app = express();
app.use(cors({
  origin: process.env.PUBLIC_URL ? process.env.PUBLIC_URL : 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json());

const { Pool } = pg;
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : undefined,
  max: 50,                    
  min: 5,                    
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  maxUses: 7500,
  allowExitOnIdle: true
});

const PgSession = connectPgSimple(session);

interface PgStoreOptions {
  pool: pg.Pool;
  tableName: string;
  createTableIfMissing?: boolean;
  pruneSessionInterval?: number;
  errorLog?: (err: Error) => void;
}

const sessionStore = new PgSession({
  pool: pool,
  tableName: 'session',
  createTableIfMissing: true,
  pruneSessionInterval: 15 * 60,
  errorLog: (err: Error) => {
    logger.log('error', `Session store error: ${err.message}`);
  },
} as PgStoreOptions);

app.use(
  session({
    store: sessionStore,
    secret: process.env.SESSION_SECRET || 'mx-session',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      maxAge: 24 * 60 * 60 * 1000,
    }
  })
);

const server = http.createServer(app);

/**
 * Globally exported singleton instance of socket.io for socket communication with the client.
 */
export let io: Server;

/**
 * {@link BrowserPool} globally exported singleton instance for managing browsers.
 */
export const browserPool = new BrowserPool();

app.use(cookieParser())

app.use('/webhook', webhook);
app.use('/record', record);
app.use('/workflow', workflow);
app.use('/storage', storage);
app.use('/auth', auth);
app.use('/integration', integration);
app.use('/proxy', proxy);
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

readdirSync(path.join(__dirname, 'api')).forEach((r) => {
  const route = require(path.join(__dirname, 'api', r));
  const router = route.default || route;
  if (typeof router === 'function') {
    app.use('/api', router);
  } else {
    console.error(`Error: ${r} does not export a valid router`);
  }
});

const isProduction = process.env.NODE_ENV === 'production';
const workerPath = path.resolve(__dirname, isProduction ? './schedule-worker.js' : './schedule-worker.ts');
const recordingWorkerPath = path.resolve(__dirname, isProduction ? './pgboss-worker.js' : './pgboss-worker.ts');

let workerProcess: any;
let recordingWorkerProcess: any;

app.get('/', function (req, res) {
  capture(
    'maxun-oss-server-run', {
    event: 'server_started',
  }
  );
  return res.send('Maxun server started 🚀');
});

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', process.env.PUBLIC_URL || 'http://localhost:5173');
  res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

if (require.main === module) {
  setInterval(() => {
    processQueuedRuns();
  }, 5000);
}

if (require.main === module) {
  server.listen(SERVER_PORT, '0.0.0.0', async () => {
    try {
      await connectDB();
      await syncDB();
      
      logger.log('info', 'Cleaning up stale browser slots...');
      browserPool.cleanupStaleBrowserSlots();
      
      await recoverOrphanedRuns();
      await startWorkers();
      
      io = new Server(server);
      
      io.of('/queued-run').on('connection', (socket) => {
        const userId = socket.handshake.query.userId as string;

        if (userId) {
          socket.join(`user-${userId}`);
          logger.log('info', `Client joined queued-run namespace for user: ${userId}, socket: ${socket.id}`);

          socket.on('disconnect', () => {
            logger.log('info', `Client disconnected from queued-run namespace: ${socket.id}`);
          });
        } else {
          logger.log('warn', `Client connected to queued-run namespace without userId: ${socket.id}`);
          socket.disconnect();
        }
      });
      
      if (!isProduction) {
        if (process.platform === 'win32') {
          workerProcess = fork(workerPath, [], {
            execArgv: ['--inspect=5859'],
          });
          workerProcess.on('message', (message: any) => {
            console.log(`Message from worker: ${message}`);
          });
          workerProcess.on('error', (error: any) => {
            console.error(`Error in worker: ${error}`);
          });
          workerProcess.on('exit', (code: any) => {
            console.log(`Worker exited with code: ${code}`);
          });

          recordingWorkerProcess = fork(recordingWorkerPath, [], {
            execArgv: ['--inspect=5860'],
          });
          recordingWorkerProcess.on('message', (message: any) => {
            console.log(`Message from recording worker: ${message}`);
          });
          recordingWorkerProcess.on('error', (error: any) => {
            console.error(`Error in recording worker: ${error}`);
          });
          recordingWorkerProcess.on('exit', (code: any) => {
            console.log(`Recording worker exited with code: ${code}`);
          });
        } else {
          // Run in same process for non-Windows
          try {
            await import('./schedule-worker');
            await import('./pgboss-worker');
            console.log('Workers started in main process for memory sharing');
          } catch (error) {
            console.error('Failed to start workers in main process:', error);
          }
        }
      }
      
      logger.log('info', `Server listening on port ${SERVER_PORT}`);    
    } catch (error: any) {
      logger.log('error', `Failed to connect to the database: ${error.message}`);
      process.exit(1);
    }
  });
}

process.on('unhandledRejection', (reason, promise) => {
  logger.log('error', `Unhandled promise rejection at: ${promise}, reason: ${reason}`);
  console.error('Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (error) => {
  logger.log('error', `Uncaught exception: ${error.message}`, { stack: error.stack });
  console.error('Uncaught exception:', error);

  if (process.env.NODE_ENV === 'production') {
    setTimeout(() => {
      process.exit(1);
    }, 5000);
  }
});

if (require.main === module) {
  process.on('SIGINT', async () => {
    console.log('Main app shutting down...');

    try {
      console.log('Closing PostgreSQL connection pool...');
      await pool.end();
      console.log('PostgreSQL connection pool closed');
    } catch (error) {
      console.error('Error closing PostgreSQL connection pool:', error);
    }

    if (!isProduction && process.platform === 'win32') {
      if (workerProcess) workerProcess.kill();
      if (recordingWorkerProcess) recordingWorkerProcess.kill();
    }
    process.exit();
  });
}