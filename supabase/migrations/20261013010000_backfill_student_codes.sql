update public.profiles
set user_code = public.generate_student_code()
where role = 'student'
  and user_code is null;
