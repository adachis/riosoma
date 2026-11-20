---
id: ai-footprint
title: AI footprint estimates
summary: How Riosoma estimates the energy and carbon of AI work, what the ranges mean, and what the estimates leave out.
area: rio
order: 1
level: standard
related: [rio, ai-fields, web-search, similar-records]
---

Whenever Rio replies, an AI field fills in a value, or Diagnose explains an automation run, a model does the work on a server somewhere, and that work uses electricity.  Riosoma shows an estimate of that energy, and of the carbon behind it, beside what the work costs.

## Where you see it

- Under each of Rio's replies, beside its tokens and cost, in a line such as "Estimate: about 0.4 to 0.9 Wh and 0.1 to 0.3 g CO2e."  {{ui:ai.footprint.howEstimated}} opens this page.
- Before a run over many records starts from {{ui:fields.ai.generateAll}}, with the run's tokens and cost.
- At the top of Rio's panel, beside the close button, once you've used AI: your own cost and estimated carbon so far this month.  Press it for {{ui:ai.pill.title}}, broken down by feature.  It reports your use and nothing else.  It doesn't compare you with anyone.
- In the AI settings, where admins choose the models for {{ui:ai.models.everyday}} and {{ui:ai.models.power}}: one to three leaves for each model, by the estimated energy of a typical reply of 500 output tokens.  Three leaves means the least energy.  Point at a model, or move to it with the keyboard, to read its estimate.  {{ui:ai.leaves.none}} means the method has no data for that model.
- In the AI settings' {{ui:ai.footprint.title}} section: your organization's totals by month, by feature, and by model, and {{ui:ai.footprint.download}}.

Diagnose shows the same line as Rio's replies, under its explanation.

## How it's estimated

For text generation, Riosoma follows EcoLogits 0.11.1, an openly published method for estimating the environmental impacts of requests to generative models.  The admin totals and their CSV file name the method with every figure.

For each request to a model, the method:

1. Looks up the model's size: its parameter count, or for a mixture-of-experts model, the parameters active for each token as well as the total.  For a model whose maker hasn't published its architecture, the method's data gives a range.
2. Estimates the GPU energy for each generated token from benchmarks of open models on data center GPUs, from the model's active parameters, and multiplies it by the tokens the request generated.
3. Works out how many GPUs it takes to hold the model and how long they generate, from speeds measured for the model where the method has them, and never longer than the request actually took.  It adds the rest of the server's energy for that time, shared among the requests the server handles at once.
4. Multiplies by the data center's power usage effectiveness (PUE), for cooling and the rest of the building's overhead.
5. Turns that energy into carbon with the electricity mix of a zone, and adds a share of the carbon it took to make the server and its GPUs, spread over three years of use.

A reply from Rio can take several requests when Rio looks things up along the way.  Each request is estimated on its own, and the reply shows their sum.

## Search and embedding calls

Searches and embeddings appear as separate features in the same totals.  Administrators can enter measured or documented power allocated to one request in {{ui:knowledge.searchPower}} and {{ui:knowledge.embeddingPower}}.  Include hosting overhead and account for concurrent requests when choosing the power.  Leave it blank when unknown, and those calls remain unestimated.

The `service-power-v1` method multiplies configured watts by the call duration in hours to estimate watt-hours.  It converts energy to carbon with the organization's electricity zone.  These are point estimates, with equal low and high values, and depend on the configured power.  They exclude hardware manufacturing, network energy, fetched pages, and upstream search engines.  The CSV identifies the method and zone used for each total.

## What the ranges mean

For text generation, every energy and carbon figure is a range, from the low end of the method's assumptions to the high end.  The range comes from what isn't known, such as how large a model really is when its maker hasn't said, and how efficient a provider's data centers are.  A narrow range means the inputs are better known.  It doesn't mean the figure is exact.  Figures show two significant digits, since more would claim a precision the method doesn't have.

The estimate before a bulk run is wider still, since it runs from every answer being as short as expected to every one being as long.

Cost isn't a range, but it's an estimate too: tokens times each model's list price, which is what Rio's usage line and the monthly budget count.  When a provider stops before reporting its tokens, Riosoma estimates them from what it sent and what came back.  The CSV file counts those calls under "Calls with estimated tokens."

## The electricity zone

The carbon from a kilowatt-hour depends on how the electricity was made, so estimates use the electricity mix of one zone: a country, Europe, or the world average.  The server's operator sets the zone with `RIOSOMA_AI_ELECTRICITY_ZONE`, and it's the world average unless they change it.  An admin can pick a different zone for the organization under {{ui:ai.footprint.zone}} in the {{ui:ai.footprint.title}} section.  Pick the zone where the models you use run, when you know it.  Energy figures don't depend on the zone.

Each estimate keeps the zone it used, so changing the zone changes new estimates and leaves the earlier ones as they were.  The CSV file has a line for each zone a month used.

## What the estimates leave out

Text generation estimates exclude:

- Models the method has no data for, including models on your own hardware, tuned models, and models newer than the method's data.  These show {{ui:ai.leaves.none}} or say there's no estimate, rather than a guess, and their cost still counts.  A request that generated nothing has no estimate either.
- The tokens sent to the model, since the method counts only the tokens it generates.
- Water, which the method also estimates, and the network, storage, and training behind a model.
- Everything outside the request, such as Riosoma's own server and your devices.

These figures are estimates to help you see the scale of your AI use.  They aren't measurements, and they aren't a statement about any provider's data centers.  See {{doc:rio}} and {{doc:ai-fields}} for what the features themselves do.
