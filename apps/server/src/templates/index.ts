import { assetCheckout } from './asset-checkout.js';
import { bugTracker } from './bug-tracker.js';
import { contentCalendar } from './content-calendar.js';
import { coursePlanner } from './course-planner.js';
import { employeeDirectory } from './employee-directory.js';
import { eventPlanning } from './event-planning.js';
import { hiringPipeline } from './hiring-pipeline.js';
import { householdBudget } from './household-budget.js';
import { inventory } from './inventory.js';
import { marketingCampaigns } from './marketing-campaigns.js';
import { meetingNotes } from './meeting-notes.js';
import { nonprofit } from './nonprofit.js';
import { okrs } from './okrs.js';
import { productRoadmap } from './product-roadmap.js';
import { projectTracker } from './project-tracker.js';
import { readingList } from './reading-list.js';
import { salesPipeline } from './sales-pipeline.js';
import { supportTickets } from './support-tickets.js';
import { travelPlanner } from './travel-planner.js';
import { vendorContracts } from './vendor-contracts.js';

/** In the order the new database dialog lists them, which groups them by category. */
export const templates = [
  projectTracker,
  salesPipeline,
  contentCalendar,
  inventory,
  bugTracker,
  productRoadmap,
  hiringPipeline,
  supportTickets,
  marketingCampaigns,
  okrs,
  meetingNotes,
  readingList,
  coursePlanner,
  householdBudget,
  travelPlanner,
  eventPlanning,
  employeeDirectory,
  vendorContracts,
  assetCheckout,
  nonprofit,
];
