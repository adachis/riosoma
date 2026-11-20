---
id: templates
title: Starting with a template
summary: Choose one of twenty starter databases with linked tables, useful views, and sample records.
area: databases
order: 15
level: simple
related: [databases-and-tables, linked-records, formulas, views, dashboards, automations]
---

A starter template creates a new database with fields, views, and sample records already connected.  Use the examples to see how the tables fit together, then adapt them to your work.

## Choosing a starting point

Choose {{ui:home.new}}, then pick a template under {{ui:home.template.choose}}.  Each item describes the template and lists its tables.  Enter the database's {{ui:home.dialog.name}} and choose {{ui:home.dialog.create}}.  Use {{ui:home.template.scratch}} if you want an empty starting point instead.

The new database goes into the folder where you choose {{ui:home.dialog.create}}.  Changing pages while creation finishes keeps that destination, including when you start outside a folder.  A database created in a shared folder inherits that folder's access.

If the database is created but filing it in the folder fails, {{ui:home.dialog.name}} becomes read-only.  Choose {{ui:home.dialog.create}} again to retry filing the same database.  You can rename it after it opens.

Templates are grouped into {{ui:templates.category.work}}, {{ui:templates.category.personal}}, and {{ui:templates.category.organizations}}.  Large lists include {{ui:ui.picker.filter}} and group buttons with counts.  Type part of a name to find a template, or hide groups you do not need.  Your browser remembers collapsed groups and shows {{ui:ui.picker.recent}} first.  Smaller lists have a category menu beside {{ui:home.template.choose}}.  See {{doc:choosing-items}} for keyboard controls.

## Work

**Project tracker** connects projects and tasks.  Tasks include status, due dates, estimated hours, review flags, and completion dates.  Project rollups count tasks and completion dates, and a formula calculates progress.  Tasks have grid, kanban, and calendar views.  Set a task's completion date to have it counted as completed.

**Sales pipeline** connects companies, contacts, and deals.  Deals include stages, amounts, probabilities, and close dates.  A formula calculates weighted value, and a lookup brings in the company's industry.  A kanban board follows deal stages, and a calendar shows closing dates.

**Content calendar** connects channels and posts.  Posts include briefs, publication dates and times, statuses, word counts, and topics.  A formula estimates reading minutes, and a lookup shows the channel's cadence.  Calendar, kanban, gallery, and grid views offer different ways to review the schedule.

**Inventory** connects products, suppliers, and orders.  Products include stock levels, reorder thresholds, prices, and supplier links.  A formula flags low stock, and a lookup shows supplier lead times.  A gallery presents products, and a calendar shows expected order arrivals.

**Bug tracker** connects bugs, releases, and the team.  Bugs have a severity, an area, platforms, steps to reproduce, and the number of days they have been open.  A view lists open bugs with the most severe first, a board follows each bug's status, and a chart shows open bugs by area.  A timeline shows releases, each release counts its bugs, and each person's open bugs add up on their record.

**Product roadmap** connects features, customer feedback, and releases.  Features have a theme, a horizon of now, next, or later, start and target dates, progress, and a priority score from impact, confidence, and effort.  The roadmap is a Gantt chart with an arrow from each feature to the ones that depend on it, and a timeline groups features by theme.  Feedback links to the feature it asks for, and each feature counts its requests.

**Hiring pipeline** connects candidates, roles, and interviews.  A board follows each candidate's stage, interview scores average onto the candidate, and a calendar shows interviews.  An application form collects new candidates, and a dashboard shows open roles, active candidates, and where candidates come from.

**Customer support** connects tickets, customers, and agents.  Tickets have a status, a priority, a channel, and the hours they took to solve.  A board follows each ticket's status, views list open and urgent tickets, and a chart compares channels.  Customers and agents total their open tickets and average satisfaction, and a dashboard sums up the queue.

**Marketing campaigns** connects campaigns, their activities, and audiences.  Each campaign has a date range, a budget, and the spending and conversions its activities add up to, with the cost per conversion.  A timeline shows campaigns by goal, a calendar shows launch dates, and charts compare campaigns and channels.  A dashboard shows spending and results.

**OKRs and goals** connects objectives, key results, and check-ins.  Each key result measures its progress from a starting value toward its target, and each objective averages its key results.  Check-ins record new values and confidence, and a dashboard shows progress and the key results that need attention.

**Meeting notes and decisions** connects meetings, decisions, action items, and people.  Meetings have agendas, notes, attendees, lengths, and recordings.  Decisions have a status and an owner, and action items have due dates and show when they are overdue.  A calendar shows meetings, and each person's open action items add up on their record.

## Personal

**Reading list** connects books and authors.  Books include reading status, ratings, page counts, pages read, finish dates, and notes.  A formula calculates progress, and a lookup brings in the author's genre.  A kanban board groups reading stages, and a gallery presents the books.

**Class and course planner** connects courses, assignments, and study sessions.  Courses have a term, meeting days, credits, and a letter grade from the final score.  Assignments have due dates, weights, and scores, which average onto each course.  A calendar shows due dates, a board follows each assignment's status, and a second calendar schedules study time.

**Household budget** connects transactions, spending categories, and bills.  Each category has a monthly budget and shows what is left to spend.  Views list expenses and income with their totals, a chart shows spending by category, and a pivot table totals each category by month.  Bills show the days until they are due, and a dashboard sums up the month.

**Travel planner** connects trips, places, and bookings.  Each trip has a date range, a budget, and what is booked so far.  A timeline shows trips, a map shows the places you want to go, and a calendar lays out each day's plans.  Bookings keep confirmation numbers, costs, and cancellation deadlines.

## Organizations

**Event planning** connects events, guests, and vendors.  Events have start and end times, venues, and budgets.  Vendor costs roll up to each event, and a formula calculates the remaining budget.  A calendar shows events, and a guest response form collects contact details, attendance responses, and dietary notes.

**Employee directory** connects people, teams, and offices.  People have titles, contact details, start dates, skills, and a manager, and an org chart nests everyone under the person they report to.  Directory cards show people at a glance, teams count their members, and a map shows every office.

**Vendors and contracts** connects vendors, contracts, and invoices.  Each contract has a term, an annual value, and a notice period, with the last day to give notice worked out for you.  A timeline shows contract terms by vendor, a view lists contracts ending in the next 90 days, and a calendar shows notice deadlines.  A dashboard sums up spending and upcoming renewals.

**Asset checkout** connects shared equipment, checkouts, and borrowers.  Each checkout has a pickup date, a due date, and a return date, and shows when it is overdue.  A timeline shows each item's checkouts in a lane of its own, a catalog shows the equipment, and a form collects requests.

**Donors and volunteers** connects supporters, donations, volunteer shifts, and signups.  Supporters show their lifetime giving, latest gift, and volunteer hours.  A chart shows giving by month, a view lists gifts that still need a thank-you, and shifts count their signups and open spots.  A sign-up form collects new volunteers, and a dashboard sums up giving and volunteering.

## Dashboards and automations

Several templates include a dashboard, listed under {{ui:dashboards.section}} in the database's sidebar.  Some also include an automation, such as recording when a bug is resolved or a ticket is solved, or setting up a new application from a form response.  Automations start turned off, so nothing runs until you turn one on.  See {{doc:dashboards}} and {{doc:automations}}.

## Making it yours

The created database is independent of the starter.  Rename fields, adjust views, and replace the sample records as needed.  Sample dates are placed relative to when the database is created.  See {{doc:linked-records}} and {{doc:formulas}} before changing fields that other fields depend on.
