import { z } from "zod";
const addressSchema = z.object({
  fullAddress: z.string().optional(),
  streetAddress: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  zip: z.string().optional(),
});

const signupSchema = z.object({
  firstName: z
    .string({ required_error: "First name is required" })
    .min(1, "First name cannot be empty"),

  lastName: z
    .string({ required_error: "Last name is required" })
    .min(1, "Last name cannot be empty"),

  email: z
    .string({ required_error: "Email is required" })
    .email("Invalid email format"),

  password: z
    .string({ required_error: "Password is required" })
    .min(6, "Password must be at least 6 characters long"),
  organization: z.string().optional(),

  phone: z
    .string({ required_error: "Phone is required" })
    .min(10, "Phone must be at least 10 digits"), // adjust to your format rules

  gender: z.enum(["male", "female", "other"]).optional(),

  isAdmin: z.boolean().optional(),
  date_of_birth: z.boolean().optional(),

  address: addressSchema.optional(),
});
export { signupSchema };
