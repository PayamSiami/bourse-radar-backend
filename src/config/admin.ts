
import AdminJS from "adminjs";
import AdminJSFastify from "@adminjs/fastify";
import { Adapter, Database, Resource } from "@adminjs/sql";
import argon2 from "argon2";
import FastifySession from "@fastify/session";
import Connect from "connect-pg-simple";
import type { FastifyInstance } from "fastify";

// --------------------------------------------------
// Environment
// --------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH;
const ADMIN_COOKIE_SECRET = process.env.ADMIN_COOKIE_SECRET;

const isProduction = process.env.NODE_ENV === "production";

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

if (!ADMIN_EMAIL || !ADMIN_PASSWORD_HASH) {
  throw new Error("ADMIN_EMAIL and ADMIN_PASSWORD_HASH are required");
}

if (!ADMIN_COOKIE_SECRET || ADMIN_COOKIE_SECRET.length < 32) {
  throw new Error("ADMIN_COOKIE_SECRET must be at least 32 characters");
}

// --------------------------------------------------
// Register PostgreSQL adapter
// --------------------------------------------------

AdminJS.registerAdapter({
  Database,
  Resource,
});

// --------------------------------------------------
// Authentication
// --------------------------------------------------

async function authenticate(
  email: string,
  password: string,
) {
  if (
    !email ||
    !password ||
    email.trim().toLowerCase() !== ADMIN_EMAIL!.trim().toLowerCase()
  ) {
    return null;
  }

  try {
    const valid = await argon2.verify(
      ADMIN_PASSWORD_HASH!,
      password,
    );

    if (!valid) {
      return null;
    }

    return {
      email: ADMIN_EMAIL,
      role: "admin",
    };
  } catch {
    return null;
  }
}

// --------------------------------------------------
// Resource configuration
// --------------------------------------------------

function buildResources(db: any) {
  return [
    // USERS
    {
      resource: db.table("users"),

      options: {
        navigation: {
          name: "Management",
          icon: "Users",
        },

        properties: {
          id: {
            isVisible: {
              list: true,
              show: true,
              filter: true,
              edit: false,
            },
          },

          email: {
            isTitle: true,
          },

          password: {
            isVisible: false,
          },

          passwordHash: {
            isVisible: false,
          },

          password_hash: {
            isVisible: false,
          },

          isAdmin: {
            isVisible: {
              list: true,
              show: true,
              filter: true,
              edit: false,
            },
          },

          createdAt: {
            isVisible: {
              list: true,
              show: true,
              filter: true,
              edit: false,
            },
          },
        },

        listProperties: [
          "id",
          "email",
          "fullName",
          "isAdmin",
          "verified",
          "createdAt",
        ],

        editProperties: [
          "email",
          "fullName",
          "verified",
        ],

        actions: {
          new: {
            isAccessible: false,
          },

          delete: {
            isAccessible: false,
          },
        },
      },
    },

    // TICKETS
    {
      resource: db.table("tickets"),

      options: {
        navigation: {
          name: "Management",
          icon: "Ticket",
        },

        properties: {
          id: {
            isVisible: {
              list: true,
              show: true,
              edit: false,
            },
          },

          title: {
            isTitle: true,
          },

          createdAt: {
            isVisible: {
              list: true,
              show: true,
              edit: false,
            },
          },

          resolvedAt: {
            isVisible: {
              list: true,
              show: true,
              edit: false,
            },
          },
        },

        listProperties: [
          "id",
          "title",
          "status",
          "priority",
          "createdAt",
        ],

        editProperties: [
          "title",
          "status",
          "priority",
        ],
      },
    },

    // STOCKS
    {
      resource: db.table("stocks"),

      options: {
        navigation: {
          name: "Market",
          icon: "TrendingUp",
        },

        properties: {
          id: {
            isVisible: {
              list: true,
              show: true,
              edit: false,
            },
          },

          symbol: {
            isTitle: true,
          },

          createdAt: {
            isVisible: false,
          },
        },

        listProperties: [
          "id",
          "symbol",
          "name",
          "sector",
          "price",
        ],

        actions: {
          new: {
            isAccessible: false,
          },

          edit: {
            isAccessible: false,
          },

          delete: {
            isAccessible: false,
          },

          bulkDelete: {
            isAccessible: false,
          },
        },
      },
    },

    // TASKS
    {
      resource: db.table("tasks"),

      options: {
        navigation: {
          name: "Operations",
          icon: "ClipboardList",
        },

        properties: {
          id: {
            isVisible: {
              list: true,
              show: true,
              edit: false,
            },
          },

          title: {
            isTitle: true,
          },

          createdAt: {
            isVisible: {
              list: true,
              show: true,
              edit: false,
            },
          },
        },

        listProperties: [
          "id",
          "title",
          "description",
          "status",
          "priority",
          "phase",
          "dueDate",
        ],

        editProperties: [
          "title",
          "description",
          "status",
          "priority",
          "phase",
          "dueDate",
        ],
      },
    },
  ];
}

// --------------------------------------------------
// Initialize AdminJS
// --------------------------------------------------

export async function registerAdmin(app: FastifyInstance) {
  const databaseUrl = new URL(DATABASE_URL!);

  const databaseName = decodeURIComponent(
    databaseUrl.pathname.replace(/^\//, ""),
  );

  if (!databaseName) {
    throw new Error("Invalid PostgreSQL database name");
  }

  const db = await new Adapter("postgresql", {
    connectionString: DATABASE_URL,
    database: databaseName,
  }).init();

  const adminJS = new AdminJS({
    rootPath: "/admin",

    branding: {
      companyName: "Bourse Radar",
      withMadeWithLove: false,
    },

    resources: buildResources(db),
  });

  if (!isProduction) {
    adminJS.watch();
  }

  // PostgreSQL session store
  const ConnectSession = Connect(FastifySession as any);

  const sessionStore = new ConnectSession({
    conObject: {
      connectionString: DATABASE_URL,
    },

    tableName: "admin_sessions",
    createTableIfMissing: false,
  });

  // Fastify AdminJS router
  await AdminJSFastify.buildAuthenticatedRouter(
    adminJS,
    {
      authenticate,

      cookieName: "bourse-radar-admin",
      cookiePassword: ADMIN_COOKIE_SECRET!,
    },
    app,
    {
      store: sessionStore as any,

      secret: ADMIN_COOKIE_SECRET!,

      saveUninitialized: false,

      cookie: {
        httpOnly: true,
        secure: isProduction,
        sameSite: "lax",
        path: "/admin",
        maxAge: 8 * 60 * 60 * 1000,
      },
    },
  );

  app.log.info("AdminJS initialized at /admin");

  return adminJS;
}

export default registerAdmin;
