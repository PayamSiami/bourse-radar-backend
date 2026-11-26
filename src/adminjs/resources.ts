/**
 * Builds the AdminJS resources array for the Bourse Radar backend.
 * Each resource is configured with properties, list/show/edit properties,
 * and actions visible in the AdminJS dashboard.
 */

import type { Adapter } from "@adminjs/sql";

type DB = Awaited<ReturnType<Adapter["init"]>>;

export function buildAdminResources(db: DB) {
  const hidden = {
    isVisible: false,
  };

  return [
    // USERS
    {
      resource: db.table("users"),
      options: {
        navigation: {
          name: "User Management",
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

          password: hidden,
          passwordHash: hidden,
          resetToken: hidden,
          refreshToken: hidden,
          verificationToken: hidden,

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

          updatedAt: {
            isVisible: {
              list: false,
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

        showProperties: [
          "id",
          "email",
          "fullName",
          "isAdmin",
          "verified",
          "createdAt",
          "updatedAt",
        ],

        editProperties: ["email", "fullName", "verified"],

        actions: {
          new: { isAccessible: false },
          delete: { isAccessible: false },
          edit: { isAccessible: true },
        },
      },
    },

    // TICKETS
    {
      resource: db.table("tickets"),
      options: {
        navigation: {
          name: "Support",
          icon: "Ticket",
        },

        properties: {
          id: {
            isVisible: { list: true, show: true, edit: false },
          },

          title: {
            isTitle: true,
          },

          createdAt: {
            isVisible: { list: true, show: true, edit: false },
          },

          resolvedAt: {
            isVisible: { list: true, show: true, edit: false },
          },
        },

        listProperties: ["id", "title", "status", "priority", "createdAt"],

        editProperties: ["title", "status", "priority"],
      },
    },

    // STOCKS
    {
      resource: db.table("stocks"),
      options: {
        navigation: {
          name: "Market Data",
          icon: "TrendingUp",
        },

        properties: {
          id: {
            isVisible: { list: true, show: true, edit: false },
          },

          symbol: {
            isTitle: true,
          },

          name: {
            isVisible: {
              list: true,
              show: true,
              filter: true,
              edit: true,
            },
          },

          sector: {
            isVisible: {
              list: true,
              show: true,
              filter: true,
              edit: true,
            },
          },

          price: {
            isVisible: {
              list: true,
              show: true,
              filter: true,
              edit: true,
            },
          },

          createdAt: {
            isVisible: { list: true, show: true, filter: true },
          },

          updatedAt: {
            isVisible: { list: true, show: true, filter: true },
          },
        },

        listProperties: ["symbol", "name", "sector", "price", "createdAt"],

        showProperties: ["symbol", "name", "sector", "price", "createdAt"],

        actions: {
          new: { isAccessible: true },
          edit: { isAccessible: true },
          delete: { isAccessible: true },
          bulkDelete: { isAccessible: false },
        },
      },
    },

    // SYMBOL SECTOR MARGINS
    {
      resource: db.table("symbol_sector_margins"),
      options: {
        navigation: {
          name: "Sector Margins",
          icon: "TrendingUp",
        },
        properties: {
          id: {
            isVisible: { list: true, show: true, filter: true, edit: false },
          },
          // FK → stocks.symbol. AdminJS turns this into a dropdown of stocks.
          symbol: {
            isVisible: { list: true, show: true, filter: true, edit: true },
            reference: "stocks",
          },
          sector: {
            isVisible: { list: true, show: true, filter: true, edit: true },
          },
          profit_margin: {
            isVisible: { list: true, show: true, filter: true, edit: true },
            type: "number",
          },
          effective_from: {
            isVisible: { list: true, show: true, filter: true, edit: true },
          },
          effective_to: {
            isVisible: { list: true, show: true, filter: true, edit: true },
          },
        },
        listProperties: ["symbol", "profit_margin", "effective_from"],
        showProperties: [
          "symbol",
          "profit_margin",
          "effective_from",
          "effective_to",
        ],
        editProperties: [
          "symbol",
          "profit_margin",
          "effective_from",
          "effective_to",
        ],
        actions: {
          new: { isAccessible: true },
          edit: { isAccessible: true },
          delete: { isAccessible: true },
        },
      },
    },

    // MONTHLY SALES
    {
      resource: db.table("monthly_sales"),
      options: {
        navigation: {
          name: "Monthly Sales",
          icon: "Calendar",
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

          symbol: {
            isVisible: {
              list: true,
              show: true,
              filter: true,
              edit: true,
            },
            reference: "stocks",
          },

          month_end: {
            isVisible: {
              list: true,
              show: true,
              filter: true,
              edit: true,
            },
          },

          sales_amount_million_rial: {
            isVisible: {
              list: true,
              show: true,
              filter: true,
              edit: true,
            },
            type: "number",
          },

          sales_usd: {
            isVisible: {
              list: true,
              show: true,
              filter: true,
              edit: true,
            },
            type: "number",
          },

          domestic_usd: {
            isVisible: {
              list: false,
              show: true,
              filter: true,
              edit: true,
            },
            type: "number",
          },

          export_usd: {
            isVisible: {
              list: false,
              show: true,
              filter: true,
              edit: true,
            },
            type: "number",
          },

          service_usd: {
            isVisible: {
              list: false,
              show: true,
              filter: true,
              edit: true,
            },
            type: "number",
          },

          ytd_total_usd: {
            isVisible: {
              list: false,
              show: true,
              filter: true,
              edit: true,
            },
            type: "number",
          },

          ytd_prior_year_usd: {
            isVisible: {
              list: false,
              show: true,
              filter: true,
              edit: true,
            },
            type: "number",
          },

          fx_rate_rial: {
            isVisible: {
              list: false,
              show: true,
              filter: true,
              edit: true,
            },
            type: "number",
          },

          fx_quality: {
            isVisible: {
              list: false,
              show: true,
              filter: true,
              edit: true,
            },
          },

          fx_sources: {
            isVisible: {
              list: false,
              show: true,
              filter: true,
              edit: true,
            },
          },

          is_estimated: {
            isVisible: {
              list: true,
              show: true,
              filter: true,
              edit: true,
            },
            type: "boolean",
          },

          source_url: {
            isVisible: {
              list: true,
              show: true,
              filter: true,
              edit: true,
            },
          },

          detail: {
            isVisible: {
              list: false,
              show: true,
              filter: false,
              edit: true,
            },
          },

          fetched_at: {
            isVisible: {
              list: true,
              show: true,
              filter: true,
              edit: true,
            },
          },
        },

        listProperties: [
          "symbol",
          "month_end",
          "sales_amount_million_rial",
          "sales_usd",
          "is_estimated",
        ],

        showProperties: [
          "symbol",
          "month_end",
          "sales_amount_million_rial",
          "sales_usd",
          "domestic_usd",
          "export_usd",
          "service_usd",
          "ytd_total_usd",
          "ytd_prior_year_usd",
          "fx_rate_rial",
          "fx_quality",
          "fx_sources",
          "is_estimated",
          "source_url",
        ],

        editProperties: [
          "symbol",
          "month_end",
          "sales_amount_million_rial",
          "sales_usd",
          "domestic_usd",
          "export_usd",
          "service_usd",
          "ytd_total_usd",
          "ytd_prior_year_usd",
          "fx_rate_rial",
          "fx_quality",
          "fx_sources",
          "is_estimated",
          "source_url",
        ],

        actions: {
          new: { isAccessible: true },
          edit: { isAccessible: true },
          delete: { isAccessible: true },
        },
      },
    },

    // QUARTERLY FINANCIALS
    {
      resource: db.table("quarterly_financials"),
      options: {
        navigation: {
          name: "Quarterly Financials",
          icon: "BarChart",
        },
        properties: {
          symbol: {
            isVisible: {
              list: true,
              show: true,
              filter: true,
              edit: true,
            },
            reference: "stocks",
          },

          fiscal_year: {
            isVisible: {
              list: true,
              show: true,
              filter: true,
              edit: true,
            },
          },

          quarter: {
            isVisible: {
              list: true,
              show: true,
              filter: true,
              edit: true,
            },
          },

          period_start: {
            isVisible: {
              list: true,
              show: true,
              filter: true,
              edit: true,
            },
          },

          period_end: {
            isVisible: {
              list: true,
              show: true,
              filter: true,
              edit: true,
            },
          },

          revenue: {
            isVisible: {
              list: true,
              show: true,
              filter: true,
              edit: true,
            },
            type: "number",
          },

          net_profit: {
            isVisible: {
              list: true,
              show: true,
              filter: true,
              edit: true,
            },
            type: "number",
          },

          net_margin: {
            isVisible: {
              list: true,
              show: true,
              filter: true,
              edit: true,
            },
            type: "number",
          },

          revenue_billion_rial: {
            isVisible: {
              list: false,
              show: true,
              filter: true,
              edit: true,
            },
            type: "number",
          },

          net_profit_billion_rial: {
            isVisible: {
              list: false,
              show: true,
              filter: true,
              edit: true,
            },
            type: "number",
          },

          eps_rials: {
            isVisible: {
              list: false,
              show: true,
              filter: true,
              edit: true,
            },
            type: "number",
          },

          shares_outstanding: {
            isVisible: {
              list: false,
              show: true,
              filter: true,
              edit: true,
            },
            type: "number",
          },

          source_url: {
            isVisible: {
              list: false,
              show: true,
              filter: true,
              edit: true,
            },
          },

          fetched_at: {
            isVisible: {
              list: false,
              show: true,
              filter: true,
              edit: true,
            },
          },
        },

        listProperties: [
          "symbol",
          "fiscal_year",
          "quarter",
          "revenue",
          "net_profit",
          "net_margin",
        ],

        showProperties: [
          "symbol",
          "fiscal_year",
          "quarter",
          "period_start",
          "period_end",
          "revenue",
          "net_profit",
          "net_margin",
          "revenue_billion_rial",
          "net_profit_billion_rial",
          "eps_rials",
          "shares_outstanding",
          "source_url",
        ],

        editProperties: [
          "symbol",
          "fiscal_year",
          "quarter",
          "period_start",
          "period_end",
          "revenue",
          "net_profit",
          "net_margin",
          "revenue_billion_rial",
          "net_profit_billion_rial",
          "eps_rials",
          "shares_outstanding",
          "source_url",
        ],

        actions: {
          new: { isAccessible: true },
          edit: { isAccessible: true },
          delete: { isAccessible: true },
        },
      },
    },

    // FORWARD P/E
    {
      resource: db.table("forward_pe"),
      options: {
        navigation: {
          name: "Forward P/E",
          icon: "TrendingUp",
        },
        properties: {
          symbol: {
            isVisible: {
              list: true,
              show: true,
              filter: true,
              edit: true,
            },
            reference: "stocks",
          },

          calculated_at: {
            isVisible: {
              list: true,
              show: true,
              filter: true,
              edit: true,
            },
          },

          estimated_annual_eps: {
            isVisible: {
              list: true,
              show: true,
              filter: true,
              edit: true,
            },
            type: "number",
          },

          forward_pe: {
            isVisible: {
              list: true,
              show: true,
              filter: true,
              edit: true,
            },
            type: "number",
          },

          confidence: {
            isVisible: {
              list: true,
              show: true,
              filter: true,
              edit: true,
            },
          },

          confidence_score: {
            isVisible: {
              list: true,
              show: true,
              filter: true,
              edit: true,
            },
            type: "number",
          },

          method: {
            isVisible: {
              list: true,
              show: true,
              filter: true,
              edit: true,
            },
          },

          margin_source: {
            isVisible: {
              list: false,
              show: true,
              filter: true,
              edit: true,
            },
          },

          margin_used: {
            isVisible: {
              list: false,
              show: true,
              filter: true,
              edit: true,
            },
            type: "number",
          },

          sales_count: {
            isVisible: {
              list: false,
              show: true,
              filter: true,
              edit: true,
            },
            type: "integer",
          },

          disclaimer: {
            isVisible: {
              list: false,
              show: true,
              filter: true,
              edit: true,
            },
          },

          calculation_json: {
            isVisible: {
              list: false,
              show: true,
              filter: false,
              edit: true,
            },
          },
        },

        listProperties: ["symbol", "calculated_at", "forward_pe", "confidence"],

        showProperties: [
          "symbol",
          "calculated_at",
          "estimated_annual_eps",
          "forward_pe",
          "confidence",
          "confidence_score",
          "method",
          "sales_count",
        ],

        editProperties: [
          "symbol",
          "calculated_at",
          "estimated_annual_eps",
          "forward_pe",
          "confidence",
          "confidence_score",
          "method",
          "margin_source",
          "margin_used",
          "sales_count",
          "disclaimer",
        ],

        actions: {
          new: { isAccessible: true },
          edit: { isAccessible: true },
          delete: { isAccessible: true },
        },
      },
    },
  ];
}