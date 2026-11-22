
export function buildAdminResources(db: any) {
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
              filter: false,
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

          edit: {
            isAccessible: true,
          },
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
          name: "Market Data",
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

          updatedAt: {
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
  ];
}
