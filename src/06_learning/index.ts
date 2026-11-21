// Learning: deterministic A/B assignment for outreach, engagement tracking and per-variant
// metrics, plus multi-touch attribution of booked meetings. Other stages and runners import
// from here, never from the files below.

export {
  assignVariant,
  FIRST_TOUCH_EXPERIMENT,
  renderTemplate,
  VARIANT_IDS,
  VariantIdSchema,
  type Experiment,
  type ExperimentVariant,
  type VariantId,
} from './experiments';
export {
  createEventStore,
  EngagementEventSchema,
  EngagementEventTypeSchema,
  getExperimentMetrics,
  trackEvent,
  type EngagementEvent,
  type EngagementEventType,
  type ExperimentMetrics,
  type VariantMetrics,
} from './tracker';
export { attributeConversion, describeAttribution, type Attribution } from './attribution';
