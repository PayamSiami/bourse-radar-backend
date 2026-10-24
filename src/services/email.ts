// import nodemailer from "nodemailer";
// import { logger } from "#utils/logger";

// export interface EmailOptions {
//   to: string;
//   subject: string;
//   html: string;
//   text?: string;
// }

// export class EmailService {
//   private transporter: nodemailer.Transporter;
//   private fromAddress: string;
//   private fromName: string;

//   constructor() {
//     const smtpHost = process.env.SMTP_HOST || "smtp.gmail.com";
//     const smtpPort = parseInt(process.env.SMTP_PORT || "587");
//     const smtpUser = process.env.SMTP_USER;
//     const smtpPass = process.env.SMTP_PASS;
//     this.fromAddress = process.env.EMAIL_FROM || "noreply@boursERadarr.ir";
//     this.fromName = process.env.EMAIL_FROM_NAME || "رورس Radarr";

//     this.transporter = nodemailer.createTransport({
//       host: smtpHost,
//       port: smtpPort,
//       secure: smtpPort === 465,
//       auth:
//         smtpUser && smtpPass
//           ? {
//               user: smtpUser,
//               pass: smtpPass,
//             }
//           : undefined,
//     });
//   }

//   async sendEmail(options: EmailOptions): Promise<boolean> {
//     try {
//       // Test connection if not already configured
//       if (!this.transporter.getOption("auth")) {
//         logger.warn("SMTP not configured. Skipping email sending.");
//         return false;
//       }

//       const info = await this.transporter.sendMail({
//         from: `"${this.fromName}" <${this.fromAddress}>`,
//         to: options.to,
//         subject: options.subject,
//         html: options.html,
//         text: options.text || options.html,
//       });

//       logger.info(`Email sent to ${options.to}: ${info.messageId}`);
//       return true;
//     } catch (error) {
//       logger.error(error, "Failed to send email");
//       return false;
//     }
//   }

//   async sendVerificationEmail(
//     to: string,
//     token: string,
//     username?: string,
//   ): Promise<boolean> {
//     const verificationUrl = `${process.env.FRONTEND_URL || "http://localhost:3000"}/verify-email?token=${token}`;

//     const html = `
//       <!DOCTYPE html>
//       <html dir="rtl" lang="fa">
//       <head>
//         <meta charset="UTF-8">
//         <meta name="viewport" content="width=device-width, initial-scale=1.0">
//         <style>
//           body {
//             font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
//             background-color: #f4f4f5;
//             color: #1f2937;
//             line-height: 1.6;
//             margin: 0;
//             padding: 0;
//           }
//           .container {
//             max-width: 600px;
//             margin: 0 auto;
//             padding: 20px;
//           }
//           .card {
//             background-color: #ffffff;
//             border-radius: 12px;
//             box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
//             overflow: hidden;
//           }
//           .header {
//             background: linear-gradient(135deg, #14b8a6 0%, #0d9488 100%);
//             color: white;
//             padding: 30px 20px;
//             text-align: center;
//           }
//           .header h1 {
//             margin: 0;
//             font-size: 24px;
//             font-weight: 700;
//           }
//           .content {
//             padding: 30px 20px;
//           }
//           .welcome {
//             font-size: 18px;
//             margin-bottom: 15px;
//           }
//           .description {
//             color: #6b7280;
//             margin-bottom: 25px;
//           }
//           .button-container {
//             text-align: center;
//             margin: 25px 0;
//           }
//           .button {
//             display: inline-block;
//             background: linear-gradient(135deg, #14b8a6 0%, #0d9488 100%);
//             color: white;
//             text-decoration: none;
//             padding: 12px 30px;
//             border-radius: 8px;
//             font-size: 16px;
//             font-weight: 600;
//             transition: transform 0.2s;
//           }
//           .button:hover {
//             transform: translateY(-2px);
//             box-shadow: 0 4px 12px rgba(20, 184, 166, 0.3);
//           }
//           .footer {
//             text-align: center;
//             padding: 20px;
//             color: #6b7280;
//             font-size: 14px;
//             border-top: 1px solid #e5e7eb;
//           }
//           .warning {
//             background-color: #fef3c7;
//             border: 1px solid #f59e0b;
//             border-radius: 6px;
//             padding: 12px;
//             margin: 20px 0;
//             text-align: center;
//             color: #92400e;
//             font-size: 14px;
//           }
//         </style>
//       </head>
//       <body>
//         <div class="container">
//           <div class="card">
//             <div class="header">
//               <h1>🎉 به Rورس Radarr خوش آمدید</h1>
//             </div>
//             <div class="content">
//               <div class="welcome">سلام ${username || "کاربر عزیز"}! 👋</div>
//               <p class="description">
//                 برای تکمیل ثبت‌نام و فعال‌سازی حساب کاربری خود، لطفاً روی دکمه زیر کلیک کنید.
//               </p>
              
//               <div class="button-container">
//                 <a href="${verificationUrl}" class="button">
//                   تأیید ایمیل
//                 </a>
//               </div>

//               <div class="warning">
//                 🔒 لینک تأیید تا 24 ساعت معتبر است. در صورت دریافت این ایمیل، آن را نادیده بگیرید.
//               </div>

//               <p class="description" style="font-size: 14px;">
//                 اگر مشکلی داشتید یا سوالی داشتید، با ما تماس بگیرید.
//               </p>
//             </div>
//             <div class="footer">
//               با احترام,<br>
//               <strong>تیم Rورس Radarr</strong><br>
//               <a href="${process.env.FRONTEND_URL || "http://localhost:3000"}">${process.env.FRONTEND_URL || "http://localhost:3000"}</a>
//             </div>
//           </div>
//         </div>
//       </body>
//       </html>
//     `;

//     const text = `
// سلام ${username || "کاربر عزیز"}!

// برای تأیید ایمیل خود و فعال‌سازی حساب کاربری، لطفاً روی لینک زیر کلیک کنید:
// ${verificationUrl}

// این لینک تا 24 ساعت معتبر است.

// با احترام،
// تیم Rورس Radarr
// ${process.env.FRONTEND_URL || "http://localhost:3000"}
//     `;

//     return this.sendEmail({
//       to,
//       subject: "تأیید ایمیل - Rورس Radarr",
//       html,
//       text,
//     });
//   }

//   async sendPasswordResetEmail(
//     to: string,
//     token: string,
//     username?: string,
//   ): Promise<boolean> {
//     const resetUrl = `${process.env.FRONTEND_URL || "http://localhost:3000"}/reset-password?token=${token}`;

//     const html = `
//       <!DOCTYPE html>
//       <html dir="rtl" lang="fa">
//       <head>
//         <meta charset="UTF-8">
//         <meta name="viewport" content="width=device-width, initial-scale=1.0">
//         <style>
//           body {
//             font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
//             background-color: #f4f4f5;
//             color: #1f2937;
//             line-height: 1.6;
//             margin: 0;
//             padding: 0;
//           }
//           .container {
//             max-width: 600px;
//             margin: 0 auto;
//             padding: 20px;
//           }
//           .card {
//             background-color: #ffffff;
//             border-radius: 12px;
//             box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
//             overflow: hidden;
//           }
//           .header {
//             background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
//             color: white;
//             padding: 30px 20px;
//             text-align: center;
//           }
//           .header h1 {
//             margin: 0;
//             font-size: 24px;
//             font-weight: 700;
//           }
//           .content {
//             padding: 30px 20px;
//           }
//           .warning {
//             background-color: #fef3c7;
//             border: 1px solid #f59e0b;
//             border-radius: 6px;
//             padding: 12px;
//             margin: 20px 0;
//             text-align: center;
//             color: #92400e;
//             font-size: 14px;
//           }
//           .button-container {
//             text-align: center;
//             margin: 25px 0;
//           }
//           .button {
//             display: inline-block;
//             background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
//             color: white;
//             text-decoration: none;
//             padding: 12px 30px;
//             border-radius: 8px;
//             font-size: 16px;
//             font-weight: 600;
//             transition: transform 0.2s;
//           }
//           .button:hover {
//             transform: translateY(-2px);
//             box-shadow: 0 4px 12px rgba(239, 68, 68, 0.3);
//           }
//           .footer {
//             text-align: center;
//             padding: 20px;
//             color: #6b7280;
//             font-size: 14px;
//             border-top: 1px solid #e5e7eb;
//           }
//         </style>
//       </head>
//       <body>
//         <div class="container">
//           <div class="card">
//             <div class="header">
//               <h1>🔐 بازیابی رمز عبور</h1>
//             </div>
//             <div class="content">
//               <p style="text-align: center; font-size: 18px; margin-bottom: 20px;">
//                 سلام ${username || "کاربر عزیز"}! 👋
//               </p>
//               <p style="text-align: center; color: #6b7280; margin-bottom: 25px;">
//                 ما یک درخواست برای بازیابی رمز عبور دریافت کرده‌ایم. برای ادامه، روی دکمه زیر کلیک کنید.
//               </p>
              
//               <div class="button-container">
//                 <a href="${resetUrl}" class="button">
//                   تنظیم رمز عبور جدید
//                 </a>
//               </div>

//               <div class="warning">
//                 ⚠️ اگر شما این درخواست را ارسال نکرده‌اید، لطفاً این ایمیل را نادیده بگیرید. رمز عبور شما تغییر نخواهد کرد.
//               </div>

//               <p style="text-align: center; color: #6b7280; font-size: 14px;">
//                 این لینک تا 1 ساعت معتبر است.
//               </p>
//             </div>
//             <div class="footer">
//               با احترام,<br>
//               <strong>تیم Rورس Radarr</strong><br>
//               <a href="${process.env.FRONTEND_URL || "http://localhost:3000"}">${process.env.FRONTEND_URL || "http://localhost:3000"}</a>
//             </div>
//           </div>
//         </div>
//       </body>
//       </html>
//     `;

//     const text = `
// سلام ${username || "کاربر عزیز"}!

// ما یک درخواست برای بازیابی رمز عبور دریافت کرده‌ایم. برای تنظیم رمز عبور جدید، لطفاً روی لینک زیر کلیک کنید:
// ${resetUrl}

// این لینک تا 1 ساعت معتبر است.

// اگر شما این درخواست را ارسال نکرده‌اید، لطفاً این ایمیل را نادیده بگیرید.

// با احترام،
// تیم Rورس Radarr
// ${process.env.FRONTEND_URL || "http://localhost:3000"}
//     `;

//     return this.sendEmail({
//       to,
//       subject: "بازیابی رمز عبور - Rورس Radarr",
//       html,
//       text,
//     });
//   }
// }

// export const emailService = new EmailService();
