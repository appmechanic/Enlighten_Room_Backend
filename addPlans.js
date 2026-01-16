// Script to add Individual and School Plans with their features and limits
// Usage: node addPlans.js

const plans = [
  // Individual Plans
  {
    category: 'Individual',
    name: 'Free Tier',
    monthlyPrice: 0,
    yearlyPrice: 0,
    features: {
      teachers: 1,
      timeLimitPerMonth: '55 minutes',
      screenLockSessions: 1,
      lessonReportsSent: 1,
      aiFeedbackTestsReports: 10,
      storage: '10 MB',
      maxStudentsPerClass: 2,
    },
    priceText: 'Free',
  },
  {
    category: 'Individual',
    name: 'Basic Plan',
    monthlyPrice: 13.9,
    yearlyPrice: 149.9,
    features: {
      teachers: 1,
      timeLimitPerMonth: '100 hours',
      screenLockSessions: 30,
      lessonReportsSent: 100,
      aiFeedbackTestsReports: 500,
      storage: '500 MB',
      maxStudentsPerClass: 2,
    },
    priceText: 'US$13.9 / month • US$149.9 / year',
  },
  {
    category: 'Individual',
    name: 'Standard Plan',
    monthlyPrice: 19.9,
    yearlyPrice: 219.9,
    features: {
      teachers: 1,
      timeLimitPerMonth: '150 hours',
      screenLockSessions: 150,
      lessonReportsSent: 150,
      aiFeedbackTestsReports: 1000,
      storage: '1 GB',
      maxStudentsPerClass: 4,
    },
    priceText: 'US$19.9 / month • US$219.9 / year',
  },
  {
    category: 'Individual',
    name: 'Premium Plan',
    monthlyPrice: 29.9,
    yearlyPrice: 329.9,
    features: {
      teachers: 1,
      timeLimitPerMonth: '240 hours',
      screenLockSessions: 240,
      lessonReportsSent: 240,
      aiFeedbackTestsReports: 3000,
      storage: '3 GB',
      maxStudentsPerClass: 20,
    },
    priceText: 'US$29.9 / month • US$329.9 / year',
  },
  // School Plans
  {
    category: 'School',
    name: 'School Basic Plan',
    monthlyPrice: 124.9,
    yearlyPrice: 1349.9,
    features: {
      teachers: 10,
      timeLimitPerMonth: '100 hours',
      screenLockSessions: 50,
      lessonReportsSent: 100,
      aiFeedbackTestsReports: 1200,
      storage: '500 MB',
      maxStudentsPerClass: 25,
    },
    priceText: 'US$124.9 / month • US$1,349.9 / year',
  },
  {
    category: 'School',
    name: 'School Standard Plan',
    monthlyPrice: 179.9,
    yearlyPrice: 1999.9,
    features: {
      teachers: 10,
      timeLimitPerMonth: '150 hours',
      screenLockSessions: 150,
      lessonReportsSent: 150,
      aiFeedbackTestsReports: 3000,
      storage: '1.2 GB',
      maxStudentsPerClass: 30,
    },
    priceText: 'US$179.9 / month • US$1,999.9 / year',
  },
  {
    category: 'School',
    name: 'School Premium Plan',
    monthlyPrice: 254.9,
    yearlyPrice: 2929.9,
    features: {
      teachers: 10,
      timeLimitPerMonth: '240 hours',
      screenLockSessions: 240,
      lessonReportsSent: 240,
      aiFeedbackTestsReports: 9000,
      storage: '3.5 GB',
      maxStudentsPerClass: 40,
    },
    priceText: 'US$254.9 / month • US$2,929.9 / year',
  },
];

// Example: Print all plans
console.log('🌱 Individual Plans');
plans.filter(p => p.category === 'Individual').forEach(plan => {
  console.log(`\n${plan.name}`);
  console.log(plan.priceText);
  Object.entries(plan.features).forEach(([feature, value]) => {
    console.log(`${feature.replace(/([A-Z])/g, ' $1')}: ${value}`);
  });
});

console.log('\n\n🏫 School Plans');
plans.filter(p => p.category === 'School').forEach(plan => {
  console.log(`\n${plan.name}`);
  console.log(plan.priceText);
  Object.entries(plan.features).forEach(([feature, value]) => {
    console.log(`${feature.replace(/([A-Z])/g, ' $1')}: ${value}`);
  });
});

// You can extend this script to insert these plans into a database as needed.
