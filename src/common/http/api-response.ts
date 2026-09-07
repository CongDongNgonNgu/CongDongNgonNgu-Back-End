export interface ApiSuccess<T> {
  success: true;
  data: T;
  message: string;
}

export interface ApiFailure {
  success: false;
  error: {
    code: string;
    message: string;
  };
}

export function success<T>(data: T, message = "OK"): ApiSuccess<T> {
  return { success: true, data, message };
}
