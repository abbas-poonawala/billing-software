# Billing System
A lightweight billing solution built for **Threads & More by LMS**, a physical retail store that specialises in Crochet supplies, ranging from threads, yarns, and other related accessories.
Built with React and Typescript on the frontend, and Vercel serverless functions on the backend. Uses Google Sheets as database, which makes it highly user friendly due to the familiarity and provides for easy accessibility; without a dedicated database setup or technical maintenance.

## Background
Small retail stores often rely on manual billing, or invest highly in generic softwares which are either too expensive or complex for their needs. This system was built specifically for Threads & More, where inventory varies by item type, shade and size - and where owner already manages stock in Google Sheets. Rather than introducing an entirely new system, this was integrated directly into that pre-existing system workflow.

## Features
1. Item and shade/size autofill from live inventory.
2. Automatic price and stock lookup per item.
3. Low stock warnings at billing time.
4. Per-bill profit tracking.
5. Stock auto-decrements on every saved bill.
6. Sequential bill numbering.
7. Loyalty points system.
8. Clean, minimalistic A4 Print Layout.
9. Editable item pricing during billing.
10. Google Sheets based configuration system.
11. Serverless deployment architecture.

## Tech Stack

- **Frontend**: React, TypeScript
- **Backend**: Vercel Serverless Functions [node.js]
- **Database**: Google Sheets API
- **Auth**: Google Service Account

## Sheets Structure
|     Tab    |                 Purpose                 |

|  Registry  |               Master List               |

|   <Item>   |  Per-item Tab with shades, stock, price |

|   Profit   | Cost Price per item/size for profit cal |

|    Bill    |              Transaction Log            |

|  Discounts |        Slab based discount config       |

## Environment Variables
```env
GOOGLE_SERVICE_ACCOUNT = 
SHEET_ID = 
LOFT_SHEET_ID =
```

## Deployment
Deployed on Vercel. Clone repository, add environment variable in the Vercel Dashboard, and deploy.

## License
[CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/)
Free to use and adapt for non-commercial purposes with attribution. See [LICENSE](./LICENSE) for details.